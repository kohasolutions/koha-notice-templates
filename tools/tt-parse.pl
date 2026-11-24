#!/usr/bin/perl
# Parses each template with Template Toolkit (the engine Koha uses) without running it, so a syntax error is found
# in CI, before anyone pastes the notice into Koha. Exit 1 if any template does not parse.
#   perl tools/tt-parse.pl notices/*/*.tt
use strict;
use warnings;
use Template::Parser;

my $bad = 0;
for my $file (@ARGV) {
    open my $fh, '<:encoding(UTF-8)', $file or die "$file: $!\n";
    my $text = do { local $/; <$fh> };
    # Koha prepends these two lines to every notice before processing it (C4::Letters::_process_tt).
    $text = '[% USE KohaDates %][% USE Remove_MARC_punctuation %]' . $text;
    my $parser = Template::Parser->new( { ENCODING => 'UTF-8' } );
    unless ( $parser->parse($text) ) {
        print STDERR "✗ $file: ", $parser->error, "\n";
        $bad++;
    }
}
exit( $bad ? 1 : 0 );
