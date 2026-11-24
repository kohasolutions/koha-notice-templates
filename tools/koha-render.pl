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
#   3. the real event happens through Koha's own code: AddIssue (checkout), AddReturn (check-in), IssueSlip (slip),
#      or the real cron script (advance_notices.pl, overdue_notices.pl, holds_reminder.pl, automatic_renewals.pl) run INSIDE this process, see run_cron;
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
use Koha::DateUtils qw(dt_from_string output_pref);
use C4::Overdues;
use Koha::Checkouts;
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

# One run at a time: every run uses the same sample ids. A named lock does not touch the transaction (unlike LOCK
# TABLES) and goes away with the connection.
my ($got_lock) = $dbh->selectrow_array(q{SELECT GET_LOCK('koha-notice-templates', 300)});
die "another run has been using this Koha for five minutes: try again later\n" unless $got_lock;

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

# The notices and the overdue triggers, as a fingerprint: compared again after the last rollback.
my $before = fingerprint();

my ( @results, @committed );
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
    $r{error} = "Koha ended the transaction: sample data may have been saved", $r{ok} = 0, push @committed, $n->{code}
        unless $schema->storage->transaction_depth == 1 && !$dbh->{AutoCommit};
    $schema->txn_rollback if $schema->storage->transaction_depth;
    push @results, \%r;
    last if @committed;    # what follows would not be protected either
}

# Every transaction was rolled back: prove it.
my @leaked = grep { $_ } (
    Koha::Libraries->find('KNTLIB')                      ? 'library KNTLIB'   : undef,
    Koha::Libraries->find('KNTLIB2')                     ? 'library KNTLIB2'  : undef,
    Koha::Patrons->search( { cardnumber => { -like => 'KNT-%' } } )->count ? 'patrons KNT-*' : undef,
    Koha::Items->search( { barcode => { -like => 'KNT-ITEM-%' } } )->count ? 'items KNT-ITEM-*' : undef,
    @committed                 ? "a committed transaction (@committed)"                        : undef,
    fingerprint() ne $before   ? 'a change in letter, overduerules, message_queue, accountlines or borrower_password_recovery' : undef,
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
    my $mtt = $n->{transport} eq 'print' ? $n->{print_as} || 'email' : $n->{transport};    # Koha keeps slips under "email"
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
    return run_advance( $n, $patron, $sc, @items ) if $sc eq 'predue' || $sc eq 'due';
    return run_overdue( $n, $patron, $sc, @items ) if $sc =~ /^overdue/;
    return scenario_hold( $n, $s )          if $sc eq 'hold';
    return scenario_hold_reminder( $n, $s ) if $sc eq 'hold_reminder';
    return scenario_auto_renewals( $n, $s ) if $sc eq 'auto_renewals';
    return scenario_advance_digest( $n, $s )       if $sc eq 'predue_digest' || $sc eq 'due_digest';
    return scenario_hold_digest( $n, $s )          if $sc eq 'hold_digest';
    return scenario_auto_renewals_digest( $n, $s ) if $sc eq 'auto_renewals_digest';
    return scenario_welcome( $n, $s )           if $sc eq 'welcome';
    return scenario_membership_expiry( $n, $s ) if $sc eq 'membership_expiry';
    return scenario_password_reset( $n, $s )    if $sc eq 'password_reset';
    die "unknown scenario '$sc'\n";
}

sub fingerprint {
    return join '|', map { $_ // '' } $dbh->selectrow_array(
        q{SELECT (SELECT CONCAT(COUNT(*), '/', SUM(CRC32(CONCAT_WS('~', code, title, content, is_html)))) FROM letter),
                 (SELECT CONCAT(COUNT(*), '/', MAX(overduerules_id)) FROM overduerules),
                 (SELECT COUNT(*) FROM overduerules_transport_types),
                 (SELECT COUNT(*) FROM message_queue), (SELECT COUNT(*) FROM accountlines),
                 (SELECT COUNT(*) FROM borrower_password_recovery)}
    );
}

# ── due and overdue notices: the real cron scripts ───────────────────────────────────────────────────────────────
# Started as its own program, a cron script would not see the sample loans and would queue real notices for every
# patron. Here its file runs inside this process, on this connection, so it works in our transaction and everything
# it queues is rolled back. The scripts only queue: nothing is sent until process_message_queue.pl, which never runs
# here, and which could not see the rows anyway.
sub run_cron {
    my ( $name, @args ) = @_;
    my ($file) = grep { -f } map { C4::Context->config('intranetdir') . "/$_/$name" } qw( misc/cronjobs ../bin/cronjobs bin/cronjobs );
    ($file) = grep { -f } "/usr/share/koha/bin/cronjobs/$name" unless $file;
    die "cannot find $name in this Koha\n" unless $file;

    local @ARGV = @args;
    local $0    = $file;
    local *STDOUT;    # overdue_notices.pl adds an output layer to STDOUT, which would corrupt our JSON
    open STDOUT, '>', '/dev/null' or die "cannot open /dev/null: $!\n";
    local $SIG{__WARN__} = sub { warn @_ unless $_[0] =~ /^Subroutine \w+ redefined/ };
    do $file;
    die "$name: $@" if $@;
    C4::Context->set_userenv( 0, 'koha', '', 'Koha', 'Staff', 'KNTLIB', 'Riverside Library', 1 );
    C4::Context->interface('intranet');
}

# PREDUE: one loan due in 3 days (the day the patron asked for) and one due in 10, which must not be mentioned.
# DUE: one loan due today and one due in 10 days.
sub run_advance {
    my ( $n, $patron, $sc, @items ) = @_;
    my $days = $sc eq 'due' ? 0 : 3;
    my $due  = dt_from_string->add( days => $days )->set( hour => 23, minute => 59, second => 0 );
    AddIssue( $patron, $items[0]->barcode, $due );
    AddIssue( $patron, $items[1]->barcode, dt_from_string->add( days => 10 ) );
    C4::Members::Messaging::SetMessagingPreference(
        {
            borrowernumber          => $patron->borrowernumber,
            message_attribute_id    => $attr{ $sc eq 'due' ? 'Item_Due' : 'Advance_Notice' },
            message_transport_types => [ $n->{transport} ],
            wants_digest            => 0,
            days_in_advance         => $days,
        }
    );
    run_cron( 'advance_notices.pl', '-c', '--library', 'KNTLIB' );
    return { %{ queued( $patron, $n->{code}, $n->{transport} ) }, due => printed_date($due) };
}

# overdue1 / overdue2 / overdue3, optionally ":fine" (Koha has charged $2.50 on the first item) or ":restricted" (the
# trigger restricts the account) or ":many" (the third item is overdue too). Triggers at 7, 14 and 28 days; two items in the stage, a third not overdue.
sub run_overdue {
    my ( $n, $patron, $sc, @items ) = @_;
    my ( $stage, $extra ) = $sc =~ /^overdue([123])(?::(fine|restricted|many))?\z/ or die "unknown scenario '$sc'\n";
    my $due = dt_from_string->subtract( days => { 1 => 8, 2 => 16, 3 => 30 }->{$stage} )
        ->set( hour => 23, minute => 59, second => 0 );
    my $many = ( $extra // '' ) eq 'many';
    AddIssue( $patron, $_->barcode, $due ) for @items[ 0, 1 ];
    AddIssue( $patron, $items[2]->barcode, $many ? $due : dt_from_string->add( days => 10 ) );

    $patron->category->overduenoticerequired(1)->store;
    $dbh->do(
        q{INSERT INTO overduerules (branchcode, categorycode, delay1, letter1, delay2, letter2, delay3, letter3,
            debarred1, debarred2, debarred3) VALUES ('KNTLIB', ?, 7, 'ODUE', 14, 'ODUE2', 28, 'ODUE3', ?, ?, ?)},
        undef, $patron->categorycode, map { ( $extra // '' ) eq 'restricted' && $_ == $stage ? 1 : 0 } 1 .. 3
    );
    $dbh->do(
        q{INSERT INTO overduerules_transport_types (letternumber, message_transport_type, overduerules_id)
          VALUES (?, ?, ?)}, undef, $stage, $n->{transport}, $dbh->last_insert_id( undef, undef, undef, undef )
    );
    if ( ( $extra // '' ) eq 'fine' ) {
        my $loan = Koha::Checkouts->find( { itemnumber => $items[0]->itemnumber } );
        C4::Overdues::UpdateFine(
            {
                issue_id       => $loan->issue_id,
                itemnumber     => $items[0]->itemnumber,
                borrowernumber => $patron->borrowernumber,
                amount         => 2.5,
                due            => $due,
            }
        );
    }
    $patron->address('12 River Road')->city('Riverside')->zipcode('90210')->store if $n->{transport} eq 'print';
    run_cron( 'overdue_notices.pl', '--library', 'KNTLIB' );
    return { %{ queued( $patron, $n->{code}, $n->{transport} ) }, due => printed_date($due) };
}

# The date as Koha prints it, for the "{DUE}" the checks look for.
sub printed_date { return output_pref( { dt => $_[0], dateonly => 1 } ) }

# ── holds and automatic renewals ─────────────────────────────────────────────────────────────────────────────────
# System preferences are set with Koha's OVERRIDE_SYSPREF_* environment variables, never saved: a saved preference
# would reach memcached and outlive the rollback. "must" in the result is text the message has to contain: the dates
# read from the database, not from the template.

sub reader_address {
    my ($patron) = @_;
    $patron->set( { address => '7 Elm Road', city => 'Riverside', zipcode => '54321' } )->store;
    Koha::Libraries->find('KNTLIB')->set( { branchzip => '12345' } )->store;
}

# Ask for the transport; for print, ask for email without having an address: that is when Koha prints.
sub wants_or_print {
    my ( $patron, $message_name, $transport ) = @_;
    wants( $patron, $message_name, $transport eq 'print' ? 'email' : $transport );
    $patron->set( { email => undef } )->store if $transport eq 'print';
    $patron->discard_changes;
}

# Place a hold and confirm it as waiting, as the check-in screen does: AddReserve, then ModReserveAffect (which
# sends HOLD through _koha_notify_reserve).
sub waiting_hold {
    my ( $patron, $item ) = @_;
    my $reserve_id = C4::Reserves::AddReserve(
        {
            branchcode     => 'KNTLIB',
            borrowernumber => $patron->borrowernumber,
            biblionumber   => $item->biblionumber,
            itemnumber     => $item->itemnumber,
            priority       => 1,
        }
    );
    C4::Reserves::ModReserveAffect( $item->itemnumber, $patron->borrowernumber, 0, $reserve_id );
    return Koha::Holds->find($reserve_id);
}

sub shown_date { return Koha::DateUtils::output_pref( { str => $_[0], dateonly => 1 } ) }

sub scenario_hold {
    my ( $n, $s ) = @_;
    require C4::Reserves;
    local $ENV{OVERRIDE_SYSPREF_RealTimeHoldsQueue}     = 0;    # no background job
    local $ENV{OVERRIDE_SYSPREF_ReservesMaxPickUpDelay} = 7;
    reader_address( $s->{patron} );
    wants_or_print( $s->{patron}, 'Hold_Filled', $n->{transport} );
    my $hold = waiting_hold( $s->{patron}, $s->{items}[0] );
    die "the hold has no pickup deadline\n" unless $hold->expirationdate;
    my $out = queued( $s->{patron}, 'HOLD', $n->{transport} );
    $out->{must} = [ shown_date( $hold->expirationdate ) ];
    return $out;
}

# Koha's own holds_reminder.pl, loaded into this process so that it works inside the rolled-back transaction, and
# limited to the sample library. Never run it as its own process: it could not see the sample and would commit.
sub scenario_hold_reminder {
    my ( $n, $s ) = @_;
    require C4::Reserves;
    local $ENV{OVERRIDE_SYSPREF_RealTimeHoldsQueue}     = 0;
    local $ENV{OVERRIDE_SYSPREF_ReservesMaxPickUpDelay} = 7;
    reader_address( $s->{patron} );
    my $last  = $n->{case} eq 'one' ? 0 : 2;
    my @holds = map { waiting_hold( $s->{patron}, $_ ) } @{ $s->{items} }[ 0 .. $last ];
    # a different deadline per hold, so a template that prints the first one three times is caught
    my $i = 0;
    $_->expirationdate( dt_from_string->add( days => 5 + $i++ )->ymd )->store for @holds;
    wants_or_print( $s->{patron}, 'Hold_Reminder', $n->{transport} );
    run_cron( 'holds/holds_reminder.pl', '-c', '--library', 'KNTLIB' );
    my $out   = queued( $s->{patron}, 'HOLD_REMINDER', $n->{transport} );
    my @shown = $n->{transport} eq 'sms' ? grep { defined } @holds[ 0, 1 ] : @holds;
    $out->{must} = [ map { shown_date( $_->expirationdate ) } @shown ];
    if    ( $n->{transport} ne 'sms' ) { push @{ $out->{must} }, @holds == 3 ? '3 items you reserved are' : 'An item you reserved is' }
    elsif ( @holds == 3 )              { push @{ $out->{must} }, 'and 1 more' }
    return $out;
}

# Koha's own automatic_renewals.pl, in this process for the same reason. Every other automatic renewal in the
# database is switched off first (rolled back with the rest), so it only looks at the sample loan. The case is made
# true with Koha's own rules, preferences, holds and charges; only 'unknown_reason' is written by hand, through the
# call the script makes, because it stands for a reason a later Koha may add.
sub scenario_auto_renewals {
    my ( $n, $s ) = @_;
    require C4::Reserves;
    require Koha::CirculationRules;
    require Koha::Cache::Memory::Lite;
    my ( $patron, $item, $case ) = ( $s->{patron}, $s->{items}[0], $n->{case} );
    die "this scenario needs Zebra: another index would be written outside the transaction\n"
        unless C4::Context->preference('SearchEngine') eq 'Zebra';

    my %on = (
        AutoRenewalNotices            => 'preferences',
        RealTimeHoldsQueue            => 0,
        RenewalSendNotice             => 0,
        CircControl                   => 'ItemHomeLibrary',
        UnseenRenewals                => 0,
        FineNoRenewals                => 100,
        FineNoRenewalsBlockAutoRenew  => 0,
        FineNoRenewalsIncludeCredits  => 0,
        OverduesBlockRenewing         => 'allow',
        RestrictionBlockRenewing      => 0,
        BlockExpiredPatronOpacActions => '',
        ItemsDeniedRenewal            => '',
        AutomaticRenewalPeriodBase    => 'now',
    );
    my %rules = (
        auto_renew          => 1,
        renewalsallowed     => 5,
        renewalperiod       => 14,
        issuelength         => 14,
        lengthunit          => 'days',
        noautorenewalbefore => 30,
        no_auto_renewal_after            => '',
        no_auto_renewal_after_hard_limit => '',
        unseen_renewals_allowed          => '',
    );
    my $issued = dt_from_string->subtract( days => 10 );
    my $due    = dt_from_string->add( days => 3 );

    if    ( $case eq 'auto_renew_final' )  { $rules{renewalsallowed} = 1 }
    elsif ( $case eq 'too_many' )          { $rules{renewalsallowed} = 0 }
    elsif ( $case eq 'auto_unseen_final' ) { $on{UnseenRenewals} = 1; $rules{unseen_renewals_allowed} = 1 }
    elsif ( $case eq 'too_unseen' )        { $on{UnseenRenewals} = 1; $rules{unseen_renewals_allowed} = 0 }
    elsif ( $case eq 'restriction' )       { $on{RestrictionBlockRenewing} = 1 }
    elsif ( $case eq 'overdue' )           { $on{OverduesBlockRenewing} = 'block'; $due = dt_from_string->subtract( days => 3 ) }
    elsif ( $case eq 'auto_too_late' )     { $rules{no_auto_renewal_after} = 5 }
    elsif ( $case eq 'auto_too_much_owing' ) { $on{FineNoRenewalsBlockAutoRenew} = 1; $on{FineNoRenewals} = 5 }
    elsif ( $case eq 'auto_account_expired' ) { $on{BlockExpiredPatronOpacActions} = 'renew' }
    elsif ( $case eq 'item_denied_renewal' ) { $on{ItemsDeniedRenewal} = 'itype: [' . $item->effective_itemtype . ']' }

    $due->set( hour => 23, minute => 59 );    # a daily loan is due at the end of the day

    local @ENV{ map { "OVERRIDE_SYSPREF_$_" } keys %on } = values %on;
    # Koha remembers rules and denied items in memory for the life of the process
    Koha::Cache::Memory::Lite->flush;
    Koha::CirculationRules->set_rules(
        { branchcode => 'KNTLIB', categorycode => $patron->categorycode, itemtype => $item->effective_itemtype, rules => \%rules } );
    Koha::Cache::Memory::Lite->flush;

    AddIssue( $patron, $item->barcode, $due, undef, $issued );
    my $checkout = Koha::Checkouts->find( { itemnumber => $item->itemnumber } ) or die "the sample loan was not made\n";
    die "the sample loan is not an automatic-renewal loan\n" unless $checkout->auto_renew;

    if ( $case eq 'restriction' ) {
        require Koha::Patron::Debarments;
        Koha::Patron::Debarments::AddDebarment( { borrowernumber => $patron->borrowernumber, type => 'MANUAL' } );
    }
    if ( $case eq 'auto_account_expired' ) {
        $patron->dateexpiry( dt_from_string->subtract( days => 2 )->ymd )->store;
        $patron->category->BlockExpiredPatronOpacActions('follow_syspref_BlockExpiredPatronOpacActions')->store;
    }
    if ( $case eq 'auto_too_much_owing' ) {
        $patron->account->add_debit( { amount => 20, type => 'MANUAL', interface => 'intranet', library_id => 'KNTLIB' } );
    }
    if ( $case eq 'on_reserve' ) {
        my $other = Koha::Patron->new(
            { cardnumber => 'KNT-0002', surname => 'Other', branchcode => 'KNTLIB', categorycode => $patron->categorycode,
              dateexpiry => dt_from_string->add( years => 1 )->ymd } )->store;
        C4::Reserves::AddReserve(
            { branchcode => 'KNTLIB', borrowernumber => $other->borrowernumber, biblionumber => $item->biblionumber,
              itemnumber => $item->itemnumber, priority => 1 } );
    }
    wants( $patron, 'Auto_Renewals', $n->{transport} );
    $dbh->do( q{UPDATE issues SET auto_renew = 0 WHERE auto_renew = 1 AND issue_id <> ?}, undef, $checkout->issue_id );

    if ( $case eq 'unknown_reason' ) {
        $checkout->auto_renew_error('a_later_koha_reason')->store;
        my $letter = C4::Letters::GetPreparedLetter(
            module      => 'circulation',
            letter_code => 'AUTO_RENEWALS',
            branchcode  => $patron->branchcode,
            tables      => {
                borrowers => $patron->borrowernumber,
                issues    => $item->itemnumber,
                items     => $item->itemnumber,
                biblio    => $item->biblionumber,
                branches  => $checkout->branchcode,
            },
            lang                   => $patron->lang,
            message_transport_type => $n->{transport},
        );
        C4::Letters::EnqueueLetter(
            { letter => $letter, borrowernumber => $patron->borrowernumber, message_transport_type => $n->{transport} } );
    } else {
        run_cron( 'automatic_renewals.pl', '-c' );
    }
    $checkout->discard_changes;
    my $error = $checkout->auto_renew_error // 'renewed';
    die "Koha answered '$error', the case is '$case'\n" unless $error eq $case || $case eq 'unknown_reason';
    my $out = queued( $patron, 'AUTO_RENEWALS', $n->{transport} );
    $out->{must} = [ shown_date( $checkout->date_due ) ];
    return $out;
}

# ── digests ("Digests only" in the patron's messaging preferences) ───────────────────────────────────────────────
sub wants_digest {
    my ( $patron, $message_name, $transport, $days ) = @_;
    C4::Members::Messaging::SetMessagingPreference(
        {
            borrowernumber          => $patron->borrowernumber,
            message_attribute_id    => $attr{$message_name},
            message_transport_types => [$transport],
            wants_digest            => 1,
            days_in_advance         => $days // 0,
        }
    );
}

# PREDUEDGST / DUEDGST, from Koha's own advance_notices.pl. The script sends digests for every library, whatever
# --library says, so every other patron's digest choice is switched off first (rolled back with the rest): they become
# ordinary patrons of other libraries, which --library skips. Case "one": item 1 is due, the others in 10 days.
sub scenario_advance_digest {
    my ( $n, $s ) = @_;
    my ( $patron, @items ) = ( $s->{patron}, @{ $s->{items} } );
    my $days = $n->{scenario} eq 'due_digest' ? 0 : 3;
    my $due  = dt_from_string->add( days => $days )->set( hour => 23, minute => 59, second => 0 );
    my $i    = 0;
    for my $item (@items) {
        AddIssue( $patron, $item->barcode, $n->{case} eq 'three' || $i == 0 ? $due->clone : dt_from_string->add( days => 10 ),
            undef, dt_from_string->subtract( days => 5 ) );    # lent five days ago, so the loan date is never the due date
        $i++;
    }
    $dbh->do( q{UPDATE borrower_message_preferences SET wants_digest = 0 WHERE wants_digest = 1 AND borrowernumber IS NOT NULL} );
    wants_digest( $patron, $days ? 'Advance_Notice' : 'Item_Due', $n->{transport}, $days );
    run_cron( 'advance_notices.pl', '-c', '--library', 'KNTLIB' );
    return { %{ queued( $patron, $n->{code}, $n->{transport} ) }, due => printed_date($due) };
}

# HOLDDGST: each hold is placed and confirmed as waiting with Koha's own code, which adds it to the unsent message.
sub scenario_hold_digest {
    my ( $n, $s ) = @_;
    require C4::Reserves;
    local $ENV{OVERRIDE_SYSPREF_RealTimeHoldsQueue}     = 0;    # no background job
    local $ENV{OVERRIDE_SYSPREF_ReservesMaxPickUpDelay} = 7;
    my ( $patron, @items ) = ( $s->{patron}, @{ $s->{items} } );
    my $case = $n->{case};
    wants_digest( $patron, 'Hold_Filled', $n->{transport} );
    Koha::Library->new(
        { branchcode => 'KNTLIB2', branchname => 'Hillside Branch', branchaddress1 => '2 Hill Road', branchcity => 'Riverside' }
    )->store if $case eq 'two_libraries';

    my @must;
    my $last = { one => 0, two_libraries => 1, three => 2 }->{$case} // die "unknown case '$case'\n";
    for my $i ( reverse 0 .. $last ) {    # the last hold is at KNTLIB: Koha takes the greeting from it
        my $item = $items[$i];
        # a different deadline per hold, so a template that repeats one is caught
        local $ENV{OVERRIDE_SYSPREF_ReservesMaxPickUpDelay} = 7 + $i;
        my $hold;
        if ( $case eq 'two_libraries' && $i == 1 ) {
            my $id = C4::Reserves::AddReserve(
                {
                    branchcode => 'KNTLIB2', borrowernumber => $patron->borrowernumber,
                    biblionumber => $item->biblionumber, itemnumber => $item->itemnumber, priority => 1,
                }
            );
            C4::Reserves::ModReserveAffect( $item->itemnumber, $patron->borrowernumber, 0, $id );
            $hold = Koha::Holds->find($id);
        } else {
            $hold = waiting_hold( $patron, $item );
        }
        die "the hold has no pickup deadline\n" unless $hold->expirationdate;
        push @must, shown_date( $hold->expirationdate );
    }
    return { %{ queued( $patron, 'HOLDDGST', $n->{transport} ) }, must => \@must };
}

# AUTO_RENEWALS_DGST, from Koha's own automatic_renewals.pl, with every other patron's automatic renewal switched off
# (rolled back). renewed: three loans. last_renewal: one loan, its last. not_renewed: one overdue loan and two reserved
# by another reader. mixed: one renewed, one reserved by another reader, one too early to renew, which must be left out.
sub scenario_auto_renewals_digest {
    my ( $n, $s ) = @_;
    require C4::Reserves;
    require Koha::CirculationRules;
    require Koha::Cache::Memory::Lite;
    my ( $patron, @items ) = ( $s->{patron}, @{ $s->{items} } );
    my $case = $n->{case};
    die "this scenario needs Zebra: another index would be written outside the transaction\n"
        unless C4::Context->preference('SearchEngine') eq 'Zebra';

    my %on = (
        AutoRenewalNotices            => 'preferences',
        RealTimeHoldsQueue            => 0,
        RenewalSendNotice             => 0,
        CircControl                   => 'ItemHomeLibrary',
        UnseenRenewals                => 0,
        FineNoRenewals                => 100,
        FineNoRenewalsBlockAutoRenew  => 0,
        OverduesBlockRenewing         => 'blockitem',
        RestrictionBlockRenewing      => 0,
        BlockExpiredPatronOpacActions => '',
        ItemsDeniedRenewal            => '',
        AutomaticRenewalPeriodBase    => 'date_due',    # each loan keeps its own new date
    );
    local @ENV{ map { "OVERRIDE_SYSPREF_$_" } keys %on } = values %on;
    Koha::Cache::Memory::Lite->flush;
    my %plan = (    # days until due, and whether another reader has reserved it
        renewed      => [ [3], [4], [5] ],
        last_renewal => [ [3] ],
        not_renewed  => [ [-3], [ 4, 1 ], [ 5, 1 ] ],
        mixed        => [ [3], [ 4, 1 ], [60] ],
    );
    my @plan = @{ $plan{$case} // die "unknown case '$case'\n" };
    Koha::CirculationRules->set_rules(
        {
            branchcode => 'KNTLIB', categorycode => $patron->categorycode, itemtype => $_,
            rules      => {
                auto_renew => 1, renewalsallowed => $case eq 'last_renewal' ? 1 : 5, renewalperiod => 14, issuelength => 14,
                lengthunit => 'days', noautorenewalbefore => 30, no_auto_renewal_after => '',
                no_auto_renewal_after_hard_limit => '', unseen_renewals_allowed => '',
            },
        }
    ) for keys %{ { map { $_->effective_itemtype => 1 } @items } };
    Koha::Cache::Memory::Lite->flush;

    my $other = Koha::Patron->new(
        {
            cardnumber   => 'KNT-0002', surname => 'Other', branchcode => 'KNTLIB', categorycode => $patron->categorycode,
            dateexpiry   => dt_from_string->add( years => 1 )->ymd,
        }
    )->store;
    for my $i ( 0 .. $#plan ) {
        my ( $days, $reserved ) = @{ $plan[$i] };
        my $due = dt_from_string->add( days => $days )->set( hour => 23, minute => 59, second => 0 );
        AddIssue( $patron, $items[$i]->barcode, $due, undef, dt_from_string->subtract( days => 10 ) );
        C4::Reserves::AddReserve(
            {
                branchcode   => 'KNTLIB', borrowernumber => $other->borrowernumber,
                biblionumber => $items[$i]->biblionumber, itemnumber => $items[$i]->itemnumber, priority => 1,
            }
        ) if $reserved;
    }
    wants_digest( $patron, 'Auto_Renewals', $n->{transport} );
    $dbh->do( q{UPDATE issues SET auto_renew = 0 WHERE auto_renew = 1 AND borrowernumber <> ?}, undef, $patron->borrowernumber );
    run_cron( 'automatic_renewals.pl', '-c' );

    my @loans = map { Koha::Checkouts->find( { itemnumber => $_->itemnumber } ) } @items[ 0 .. $#plan ];
    my @got   = map { $_->auto_renew_error // 'renewed' } @loans;
    my %want  = (
        renewed      => 'renewed renewed renewed',
        last_renewal => 'auto_renew_final',
        not_renewed  => 'overdue on_reserve on_reserve',
        mixed        => 'renewed on_reserve auto_too_soon',
    );
    die "Koha answered '@got', expected '$want{$case}'\n" unless "@got" eq $want{$case};
    my $out = queued( $patron, 'AUTO_RENEWALS_DGST', $n->{transport} );
    if ( $n->{transport} eq 'sms' ) {    # the SMS names the first two that were not renewed
        my @not = grep { $_->auto_renew_error && $_->auto_renew_error !~ /final$|too_soon$/ } @loans;
        $out->{must} = [ map { shown_date( $_->date_due ) } grep { defined } @not[ 0, 1 ] ];
    } else {
        $out->{must} = [ map { shown_date( $_->date_due ) } grep { ( $_->auto_renew_error // '' ) ne 'auto_too_soon' } @loans ];
    }
    return $out;
}

# ── membership notices ───────────────────────────────────────────────────────────────────────────────────────────
# WELCOME by email: Koha's own patron import creates the patron and queues the notice. The print version exists in
# one place only, the patron's Notices tab (members/notices.pl), a CGI script that needs a logged-in browser: its
# call is repeated here.
sub scenario_welcome {
    my ( $n, $s ) = @_;
    require Koha::Patrons::Import;
    reader_address( $s->{patron} );
    my %new = (
        cardnumber => 'KNT-0003',
        userid     => $n->{case} eq 'card_as_user_name' ? 'KNT-0003' : 'knt-welcome',
        firstname  => 'Jane',
        surname    => 'Reader',
        email      => $n->{transport} eq 'print' ? '' : 'jane.reader@example.org',
        branchcode => 'KNTLIB',
        categorycode => $s->{patron}->categorycode,
        address    => '7 Elm Road',
        city       => 'Riverside',
        zipcode    => '54321',
        dateexpiry => dt_from_string->add( years => 1 )->ymd,
    );
    my @columns = sort keys %new;
    my $csv     = join( ',', @columns ) . "\n" . join( ',', map { qq{"$_"} } @new{@columns} ) . "\n";
    open my $file, '<', \$csv or die "cannot read the sample patron file: $!\n";
    my $done = Koha::Patrons::Import->new->import_patrons(
        { file => $file, matchpoint => 'cardnumber', send_welcome => 1, defaults => {} } );
    my $patron = Koha::Patrons->find( { cardnumber => 'KNT-0003' } ) or die "Koha did not import the sample patron\n";
    if ( $n->{transport} eq 'print' ) {
        my $print = C4::Letters::GetPreparedLetter(
            module      => 'members',
            letter_code => 'WELCOME',
            branchcode  => $patron->branchcode,
            lang        => $patron->lang || 'default',
            tables      => { branches => $patron->branchcode, borrowers => $patron->borrowernumber },
            want_librarian         => 1,
            message_transport_type => 'print',
        );
        C4::Letters::EnqueueLetter(
            { letter => $print, borrowernumber => $patron->id, message_transport_type => 'print' } );
    }
    my $out = queued( $patron, 'WELCOME', $n->{transport} );
    $out->{must} = [ shown_date( $patron->dateexpiry ) ];
    return $out;
}

# Koha's own membership_expiry.pl, limited to the sample library.
sub scenario_membership_expiry {
    my ( $n, $s ) = @_;
    local $ENV{OVERRIDE_SYSPREF_MembershipExpiryDaysNotice} = 14;    # without it the script exits, and we with it
    reader_address( $s->{patron} );
    $s->{patron}->dateexpiry( dt_from_string->add( days => 14 )->ymd )->store;
    wants_or_print( $s->{patron}, 'Patron_Expiry', $n->{transport} );
    run_cron( 'membership_expiry.pl', '-c', '--branch', 'KNTLIB' );
    my $out = queued( $s->{patron}, 'MEMBERSHIP_EXPIRY', $n->{transport} );
    $out->{must} = [ shown_date( $s->{patron}->dateexpiry ) ];
    return $out;
}

# Koha's own SendPasswordRecoveryEmail. It sends the message at once, so the sender is replaced: nothing leaves Koha.
# The key is checked against Koha's table, then replaced by a word: no key is ever printed or saved.
sub scenario_password_reset {
    my ( $n, $s ) = @_;
    require Koha::AuthUtils;
    require Koha::Patron::Password::Recovery;
    local $ENV{OVERRIDE_SYSPREF_LibraryName} = $n->{case} eq 'library_name_set' ? 'Riverside Library' : '';
    my $sent = 0;
    no warnings 'redefine';
    local *C4::Letters::SendQueuedMessages = sub { $sent++; return 1 };
    Koha::Patron::Password::Recovery::SendPasswordRecoveryEmail( $s->{patron}, $s->{patron}->email, 0 );
    die "Koha did not try to send the message\n" unless $sent;
    my ($key) = $dbh->selectrow_array( q{SELECT uuid FROM borrower_password_recovery WHERE borrowernumber = ?},
        undef, $s->{patron}->borrowernumber );
    my $out = queued( $s->{patron}, 'PASSWORD_RESET', 'email' );
    $out->{content} =~ s/\Q$key\E/SAMPLE-KEY/g;
    $out->{must} = [ C4::Context->preference('OPACBaseURL') . '/cgi-bin/koha/opac-password-recovery.pl?uniqueKey=SAMPLE-KEY' ];
    die "a key that is not in Koha's table is in the message\n" if $out->{content} =~ /uniqueKey=(?!SAMPLE-KEY)\S/;
    return $out;
}
