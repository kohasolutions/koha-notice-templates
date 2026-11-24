#!/usr/bin/perl
# Reads and writes rows of Koha's letter table for tools/install.mjs. Run as the instance's user (koha-shell).
# JSON on stdin, JSON on stdout:
#   { "op": "read",  "keys": [ { module, code, branchcode, transport } ] }
#      → { "koha", "rows": [ { "row": {…}|null, "default": {is_html,title,content}|null, "others": [ … ] } ] }
#   { "op": "write", "changes": [ { key, "expect": {…}|null, "set": {…}|null, "exact": bool } ] }
#      → { "ok": 1, "rows": [ the row after the change, or null ] }
# A write is one transaction: every row is compared with "expect" first, and if one differs (somebody edited the
# notice in the meantime) nothing is written. "set": null deletes the row. "exact" also puts back id and updated_on.
use Modern::Perl;
use feature qw( state );
use utf8;
use JSON qw(decode_json encode_json);
use Koha;
use C4::Context;
use C4::Log qw( logaction );
use Koha::Database;
use Template::Parser;
use YAML::XS ();

my $in  = decode_json( do { local $/; binmode STDIN; <STDIN> } );
my $dbh = C4::Context->dbh;
my @columns = qw( id module code branchcode name is_html title content message_transport_type lang updated_on style );
C4::Context->interface('commandline');

my $out;
if    ( $in->{op} eq 'read' )  { $out = { koha => Koha::version(), rows => [ map { read_key($_) } @{ $in->{keys} } ] } }
elsif ( $in->{op} eq 'write' ) { $out = { ok => 1, rows => write_all( $in->{changes} ) } }
else                           { die "unknown op\n" }
binmode STDOUT;
print "\nKNT-JSON ", encode_json($out), "\n";

sub row_of {
    my ( $k, $lock ) = @_;
    return $dbh->selectrow_hashref(
        q{SELECT } . join( ', ', @columns ) . q{ FROM letter WHERE module = ? AND code = ? AND branchcode = ?
          AND message_transport_type = ? AND lang = 'default'} . ( $lock ? ' FOR UPDATE' : '' ),
        undef, @$k{qw( module code branchcode transport )}
    );
}

sub read_key {
    my ($k) = @_;
    my $others = $dbh->selectall_arrayref(
        q{SELECT branchcode, lang FROM letter WHERE module = ? AND code = ? AND message_transport_type = ?
          AND NOT (branchcode = ? AND lang = 'default') ORDER BY branchcode, lang},
        { Slice => {} }, @$k{qw( module code transport branchcode )}
    );
    my ($name) = $dbh->selectrow_array( q{SELECT name FROM letter WHERE module = ? AND code = ? ORDER BY id LIMIT 1},
        undef, @$k{qw( module code )} );
    return { row => row_of($k), default => default_of($k), others => $others, name => $name };
}

# Koha's own text for a notice, from the sample file it was installed with.
sub default_of {
    my ($k) = @_;
    state $samples = do {
        my ($f) = grep { -f } map { C4::Context->config('intranetdir') . "/$_" }
            qw( installer/data/mysql/en/mandatory/sample_notices.yml );
        my %by;
        if ($f) {
            my $y = YAML::XS::LoadFile($f);
            for my $t ( map { values %$_ } grep { ref eq 'HASH' } @{ $y->{tables} } ) {
                for my $r ( @{ $t->{rows} || [] } ) {
                    next unless ( $r->{lang} // '' ) eq 'default';
                    $by{ join '|', @$r{qw( module code message_transport_type )} } = {
                        is_html => $r->{is_html},
                        title   => $r->{title},
                        content => ref $r->{content} ? join( "\r\n", @{ $r->{content} } ) : $r->{content},
                    };
                }
            }
        }
        \%by;
    };
    return $samples->{ join '|', @$k{qw( module code transport )} };
}

sub differs {
    my ( $a, $b ) = @_;
    return 1 if !!$a != !!$b;
    return 0 unless $a;
    return scalar grep { ( $a->{$_} // "\0" ) ne ( $b->{$_} // "\0" ) } @columns;
}

sub write_all {
    my ($changes) = @_;
    for my $c ( grep { $_->{set} && !$_->{exact} } @$changes ) {
        my $p = Template::Parser->new( { PRE_CHOMP => 0 } );
        for my $f (qw( title content )) {
            $p->parse( $c->{set}{$f} ) or die "$c->{key}{code}: Template Toolkit: " . $p->error . "\n";
        }
        die "$c->{key}{code}: the subject is longer than 200 characters\n" if length $c->{set}{title} > 200;
    }
    my @rows;
    Koha::Database->new->schema->txn_do(
        sub {
            for my $c (@$changes) {
                my ( $k, $set ) = @$c{qw( key set )};
                my $now = row_of( $k, 1 );
                die "$k->{code} $k->{transport}: changed in Koha since it was read; nothing was written\n"
                    if differs( $now, $c->{expect} );
                my $done;
                if ( !$set ) {
                    $dbh->do( q{DELETE FROM letter WHERE id = ?}, undef, $now->{id} ) if $now;
                    $done = 'DELETE';
                } else {
                    my @set = grep { $c->{exact} || !/^(id|updated_on)$/ } @columns;
                    my %v = ( %{ $now || {} }, %$set, branchcode => $k->{branchcode}, module => $k->{module},
                        code => $k->{code}, message_transport_type => $k->{transport}, lang => 'default' );
                    if ($now) {
                        $dbh->do( 'UPDATE letter SET ' . join( ', ', map { "$_ = ?" } @set ) . ' WHERE id = ?',
                            undef, @v{@set}, $now->{id} );
                        $done = 'MODIFY';
                    } else {
                        my @ins = grep { defined $v{$_} } @set;
                        $dbh->do( 'INSERT INTO letter (' . join( ', ', @ins ) . ') VALUES ('
                                . join( ', ', map { '?' } @ins ) . ')', undef, @v{@ins} );
                        $done = 'CREATE';
                    }
                }
                my $after = row_of($k);
                # what Tools > Notices and slips writes to the log
                logaction( 'NOTICES', $done, ( $after || $now )->{id}, ( $after || $now )->{content}, 'Intranet' )
                    if ( $after || $now ) && C4::Context->preference('NoticesLog');
                push @rows, $after;
            }
        }
    );
    return \@rows;
}
