#!/usr/bin/perl
# Runs each notice through the code a real Koha library runs, and prints what Koha produced.
#
# Reads JSON on stdin: { "notices": [ { "code", "module", "transport", "is_html", "title", "content", "scenario" } ] }
# Prints JSON on stdout: { "koha": "<version>", "results": [ { "code", "transport", "ok", "subject", "content",
#   "content_type", "error", "sample": {...} } ] }
#
# For every notice, inside ONE database transaction that is always rolled back:
#   1. a sample patron, library and items are created (so the output never depends on what else is in the database);
#   2. the notice is saved in Koha's `letter` table as the default for its code and transport;
#   3. the real event happens through Koha's own code: AddIssue (checkout), AddReturn (check-in), IssueSlip (slip);
#   4. the message Koha queued (or the slip it built) is read back.
# Nothing is left in Koha afterwards. Run inside koha-shell, with KOHA_TESTING=1 so Koha does not LOCK TABLES
# (which would commit the transaction).
use Modern::Perl;
use utf8;
use JSON qw(decode_json encode_json);
use Try::Tiny;
use Koha;
use C4::Context;
use C4::Circulation qw(AddIssue AddReturn);
use C4::Members;
use C4::Members::Messaging;
use Koha::Database;
use Koha::DateUtils qw(dt_from_string);
use Koha::Patrons;
use Koha::Items;
use Koha::Libraries;
use Koha::Biblios;

# Without KOHA_TESTING, SendCirculationAlert runs LOCK TABLES, which COMMITS the open transaction and leaves the
# sample patron, items and notices in the library's database. Refuse to run at all.
die "KOHA_TESTING=1 is not set: refusing to run (it would leave data in Koha)\n" unless $ENV{KOHA_TESTING};

binmode STDIN,  ':encoding(UTF-8)';
binmode STDOUT, ':encoding(UTF-8)';

my $input  = decode_json( do { local $/; my $s = <STDIN>; utf8::encode($s); $s } );
my $schema = Koha::Database->new->schema;
my $dbh    = C4::Context->dbh;

# Sample books: the first three records that have a title, an author and an item type, by biblionumber.
my @sample_biblios = @{
    $dbh->selectcol_arrayref(
        q{SELECT b.biblionumber FROM biblio b JOIN biblioitems bi USING (biblionumber)
          WHERE b.title <> '' AND b.author <> '' AND bi.itemtype IS NOT NULL AND bi.itemtype <> ''
          ORDER BY b.biblionumber LIMIT 3}
    )
};
die "Koha has fewer than three records with a title, author and item type\n" unless @sample_biblios == 3;

my %attr = map { $_->[1] => $_->[0] }
    @{ $dbh->selectall_arrayref(q{SELECT message_attribute_id, message_name FROM message_attributes}) };

my @results;
for my $n ( @{ $input->{notices} } ) {
    my %r = ( code => $n->{code}, transport => $n->{transport}, ok => 0 );
    $schema->txn_begin;
    try {
        my $s = setup_sample();
        save_letter($n);
        my $out = run_scenario( $n, $s );
        %r = ( %r, %$out, ok => 1, sample => $s->{summary} );
    } catch {
        my ($e) = split /\n/, "$_";    # Koha's first line says what went wrong; the stack trace below it does not
        $e =~ s/\s+\z//;
        $r{error} = $e;
    };
    $schema->txn_rollback;
    push @results, \%r;
}

# Every transaction was rolled back: prove it.
my @leaked = grep { $_ } (
    Koha::Libraries->find('KNTLIB')                      ? 'library KNTLIB'   : undef,
    Koha::Patrons->find( { cardnumber => 'KNT-0001' } )  ? 'patron KNT-0001'  : undef,
    Koha::Items->search( { barcode => { -like => 'KNT-ITEM-%' } } )->count ? 'items KNT-ITEM-*' : undef,
);

my $out = encode_json( { koha => Koha::version(), results => \@results, leaked => \@leaked } );
utf8::decode($out);
print $out;

# ── sample data ──────────────────────────────────────────────────────────────────────────────────────────────────
sub setup_sample {
    my $library = Koha::Library->new(
        {
            branchcode    => 'KNTLIB',
            branchname    => 'Riverside Library',
            branchemail   => 'library@example.org',
            branchphone   => '+1 555 0100',
            branchaddress1 => '1 Main Street',
            branchcity    => 'Riverside',
        }
    )->store;
    C4::Context->set_userenv( 0, 'koha', '', 'Koha', 'Staff', 'KNTLIB', 'Riverside Library', 1 );

    # The circulation rules of the sample library allow loans of every item type (no rule = Koha's defaults).
    my $category = Koha::Patron::Categories->search( { category_type => 'A' }, { order_by => 'categorycode' } )->next
        or die "Koha has no adult patron category\n";
    my $patron = Koha::Patron->new(
        {
            cardnumber     => 'KNT-0001',
            userid         => 'knt-sample-reader',
            firstname      => 'Jane',
            surname        => 'Reader',
            email          => 'jane.reader@example.org',
            smsalertnumber => '+15550100123',
            branchcode     => 'KNTLIB',
            categorycode   => $category->categorycode,
            dateexpiry     => dt_from_string->add( years => 1 )->ymd,
            lang           => 'default',
        }
    )->store;

    $dbh->do(q{DELETE FROM item_circulation_alert_preferences});    # alerts on (Koha's default), inside the rollback

    my @items;
    my $i = 0;
    for my $bn (@sample_biblios) {
        $i++;
        my $bib  = Koha::Biblios->find($bn);
        my $item = Koha::Item->new(
            {
                biblionumber   => $bn,
                homebranch     => 'KNTLIB',
                holdingbranch  => 'KNTLIB',
                barcode        => "KNT-ITEM-$i",
                itype          => $bib->biblioitem->itemtype,
                itemcallnumber => "KNT $i",
            }
        )->store;
        push @items, $item;
    }
    return {
        patron  => $patron,
        items   => \@items,
        summary => {
            patron  => 'Jane Reader (KNT-0001), adult category ' . $category->categorycode,
            library => 'Riverside Library (KNTLIB)',
            books   => [ map { $_->biblio->title . ' / ' . ( $_->biblio->author // '' ) } @items ],
        },
    };
}

sub save_letter {
    my ($n) = @_;
    my $mtt = $n->{transport} eq 'print' ? 'email' : $n->{transport};    # Koha keeps slips under "email"
    $dbh->do(
        q{DELETE FROM letter WHERE module = ? AND code = ? AND branchcode = '' AND message_transport_type = ?
          AND lang = 'default'}, undef, $n->{module}, $n->{code}, $mtt
    );
    $dbh->do(
        q{INSERT INTO letter (module, code, branchcode, name, is_html, title, content, message_transport_type, lang)
          VALUES (?, ?, '', ?, ?, ?, ?, ?, 'default')}, undef,
        $n->{module}, $n->{code}, $n->{code}, $n->{is_html} ? 1 : 0, $n->{title}, $n->{content}, $mtt
    );
}

sub wants {
    my ( $patron, $message_name, $transport ) = @_;
    C4::Members::Messaging::SetMessagingPreference(
        {
            borrowernumber          => $patron->borrowernumber,
            message_attribute_id    => $attr{$message_name},
            message_transport_types => [$transport],
            wants_digest            => 0,
            days_in_advance         => 0,
        }
    );
}

sub queued {
    my ( $patron, $code, $transport ) = @_;
    my $rows = $dbh->selectall_arrayref(
        q{SELECT subject, content, content_type FROM message_queue
          WHERE borrowernumber = ? AND letter_code = ? AND message_transport_type = ? ORDER BY message_id},
        { Slice => {} }, $patron->borrowernumber, $code, $transport
    );
    die "Koha queued no $code $transport message\n" unless @$rows;
    die "Koha queued " . scalar(@$rows) . " $code messages; the items should have been added to one\n" if @$rows > 1;
    return { subject => $rows->[0]{subject}, content => $rows->[0]{content}, content_type => $rows->[0]{content_type} };
}

sub run_scenario {
    my ( $n, $s ) = @_;
    my ( $patron, @items ) = ( $s->{patron}, @{ $s->{items} } );
    my $sc = $n->{scenario};

    if ( $sc eq 'checkout' ) {    # two items checked out at the desk, one after the other: Koha joins them
        wants( $patron, 'Item_Checkout', $n->{transport} );
        AddIssue( $patron, $_->barcode ) for @items[ 0, 1 ];
        return queued( $patron, 'CHECKOUT', $n->{transport} );
    }
    if ( $sc eq 'checkin' ) {     # two items borrowed, then both returned
        AddIssue( $patron, $_->barcode ) for @items[ 0, 1 ];
        wants( $patron, 'Item_Check_in', $n->{transport} );
        AddReturn( $_->barcode, 'KNTLIB' ) for @items[ 0, 1 ];
        return queued( $patron, 'CHECKIN', $n->{transport} );
    }
    if ( $sc eq 'issueslip' ) {   # two current loans and one overdue, then the slip is printed
        AddIssue( $patron, $_->barcode ) for @items[ 0, 1 ];
        AddIssue( $patron, $items[2]->barcode, dt_from_string->subtract( days => 3 ) );
        my $slip = C4::Members::IssueSlip( 'KNTLIB', $patron->borrowernumber );
        die "IssueSlip returned nothing\n" unless $slip;
        return { subject => $slip->{title}, content => $slip->{content}, content_type => 'text/html' };
    }
    die "unknown scenario '$sc'\n";
}
