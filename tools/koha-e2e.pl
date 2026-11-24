#!/usr/bin/perl
# The Koha side of tools/e2e-install.mjs: a real, COMMITTED checkout for a patron made for it, then every row it made
# is deleted by id. Modes: "lock" (hold the tools' named lock until stdin closes), "snapshot" (a checksum of every table),
# "checkout", "cleanup" (also run by "checkout" itself, whatever happens).
use Modern::Perl;
use JSON qw(encode_json);
use Koha;
use C4::Context;
use C4::Circulation qw(AddIssue);
use C4::Members::Messaging;
use Koha::Database;
use Koha::DateUtils qw(dt_from_string);
use Koha::Items;
use Koha::Patrons;
use Koha::Patron::Categories;
use Koha::Biblios;
use Koha::Libraries;
use Koha::SearchEngine::Zebra::Indexer;

my $dbh  = C4::Context->dbh;
my $mode = shift // '';
my $CARD = 'KNT-E2E-1';
$| = 1;

if ( $mode eq 'lock' ) {
    my ($ok) = $dbh->selectrow_array(q{SELECT GET_LOCK('koha-notice-templates', 300)});
    say $ok ? 'locked' : 'busy';
    <STDIN>;
    exit;
}
if ( $mode eq 'snapshot' ) {
    my %s;
    for my $t ( @{ $dbh->selectcol_arrayref(q{SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'}) } ) {
        $s{$t} = join '/', $dbh->selectrow_array("SELECT COUNT(*) FROM `$t`"),
            ( $dbh->selectrow_array("CHECKSUM TABLE `$t`") )[1];
    }
    my %next = @{ $dbh->selectcol_arrayref(
        q{SELECT table_name, auto_increment FROM information_schema.tables
          WHERE table_schema = DATABASE() AND auto_increment IS NOT NULL}, { Columns => [ 1, 2 ] } ) };
    say 'KNT-JSON ', encode_json( { tables => \%s, next => \%next, log => $dbh->selectrow_array(q{SELECT COALESCE(MAX(action_id), 0) FROM action_logs}) } );
    exit;
}

sub cleanup {
    my ($from) = @_;    # the highest action_id / statistics timestamp before, when known
    my ($bn) = $dbh->selectrow_array( q{SELECT borrowernumber FROM borrowers WHERE cardnumber = ?}, undef, $CARD );
    my @items = @{ $dbh->selectcol_arrayref(q{SELECT itemnumber FROM items WHERE barcode LIKE 'KNT-E2E-ITEM-%'}) };
    my %gone;
    my $del = sub {
        my ( $table, $where, @v ) = @_;
        my $n = $dbh->do( "DELETE FROM $table WHERE $where", undef, @v );
        $gone{$table} += $n if $n > 0;
    };
    my @loans = $bn ? @{ $dbh->selectcol_arrayref( q{SELECT issue_id FROM issues WHERE borrowernumber = ?}, undef, $bn ) } : ();
    for my $i (@items) {
        $del->( 'issues',       'itemnumber = ? AND borrowernumber = ?', $i, $bn );
        $del->( 'statistics',   'itemnumber = ? AND borrowernumber = ?', $i, $bn );
        $del->( 'action_logs',  q{action_id > ? AND module IN ('CATALOGUING', 'CIRCULATION') AND object = ?}, $from->{log} // 1e12, $i );
        $del->( 'items',        'itemnumber = ?', $i );
    }
    if ($bn) {
        $del->( 'action_logs',   q{action_id > ? AND module IN ('MEMBERS', 'CIRCULATION') AND object = ?}, $from->{log} // 1e12, $bn );
        $del->( 'message_queue', 'borrowernumber = ?', $bn );
        $del->( 'borrower_message_transport_preferences',
            'borrower_message_preference_id IN (SELECT borrower_message_preference_id FROM borrower_message_preferences WHERE borrowernumber = ?)', $bn );
        $del->( 'borrower_message_preferences', 'borrowernumber = ?', $bn );
        $del->( 'borrowers', 'borrowernumber = ?', $bn );
    }
    return { deleted => \%gone, patron => $bn, items => \@items, loans => \@loans };
}

if ( $mode eq 'cleanup' ) {
    # action_logs rows need the id from before the run: this only finishes what "checkout" could not
    say 'KNT-JSON ', encode_json( cleanup( { log => $ARGV[0] } ) );
    exit;
}
die "unknown mode\n" unless $mode eq 'checkout';
die "the last run left $CARD in this Koha: run cleanup\n" if Koha::Patrons->find( { cardnumber => $CARD } );

# Nothing may leave the tables this run cleans: no search index (Zebra or other), no holds-queue job.
{
    no warnings 'redefine';
    *Koha::SearchEngine::Zebra::Indexer::index_records = sub { return 1 };
}
die "this test needs Zebra\n" unless C4::Context->preference('SearchEngine') eq 'Zebra';
$ENV{OVERRIDE_SYSPREF_RealTimeHoldsQueue} = 0;

my %from = ( log => $dbh->selectrow_array(q{SELECT COALESCE(MAX(action_id), 0) FROM action_logs}) );
say "from $from{log}";
my %out;
eval {
    my $library  = Koha::Libraries->search( {}, { order_by => 'branchcode', rows => 1 } )->next;
    my $branch   = $library->branchcode;
    C4::Context->set_userenv( 0, 'koha', '', 'Koha', 'Staff', $branch, $library->branchname, 1 );
    C4::Context->interface('intranet');
    my $category = Koha::Patron::Categories->search( { category_type => 'A' }, { order_by => 'categorycode' } )->next;
    my $patron   = Koha::Patron->new(
        { cardnumber => $CARD, userid => 'knt-e2e', firstname => 'Jane', surname => 'Reader', email => 'jane@example.org',
          branchcode => $branch, categorycode => $category->categorycode, lang => 'default',
          dateexpiry => dt_from_string->add( years => 1 )->ymd } )->store;
    my ($attr) = $dbh->selectrow_array(q{SELECT message_attribute_id FROM message_attributes WHERE message_name = 'Item_Checkout'});
    C4::Members::Messaging::SetMessagingPreference(
        { borrowernumber => $patron->borrowernumber, message_attribute_id => $attr, message_transport_types => ['email'],
          wants_digest => 0, days_in_advance => 0 } );
    my @bib = @{ $dbh->selectcol_arrayref(
        q{SELECT b.biblionumber FROM biblio b JOIN biblioitems bi USING (biblionumber) WHERE b.title <> '' AND b.author <> ''
          AND bi.itemtype <> '' ORDER BY b.biblionumber LIMIT 2}) };
    my $i = 0;
    for my $bn (@bib) {
        $i++;
        my $item = Koha::Item->new(
            { biblionumber => $bn, homebranch => $branch, holdingbranch => $branch, barcode => "KNT-E2E-ITEM-$i",
              itype => Koha::Biblios->find($bn)->biblioitem->itemtype } )->store;
        AddIssue( $patron, $item->barcode );
    }
    $out{library}  = $library->branchname;
    $out{messages} = $dbh->selectall_arrayref(
        q{SELECT subject, content, content_type, status FROM message_queue WHERE borrowernumber = ? AND letter_code = 'CHECKOUT'},
        { Slice => {} }, $patron->borrowernumber );
};
$out{error}   = "$@" if $@;
$out{cleanup} = cleanup( \%from );
say 'KNT-JSON ', encode_json( \%out );
