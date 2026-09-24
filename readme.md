Lucid Lite playground
=====================

This repo hosts a github pages site (jsonch.github.io/lucid) 
with an experimental front end and web IDE for Lucid, 
a network programming language. The syntax and feature set 
supported here is an extension of the main Lucid codebase, 
at github.com/princetonuniversity/lucid.

The web page in this repo has a compiler and interpreter that compiles 
to JavaScript, so everything can run in the browser or be downloaded 
and run locally with minimal dependencies.

Below is an LLM-generated description of the web IDE.

The page
--------

Open files are tabs in the two panes. A tab can be dragged to the other
pane, closed with its x, renamed by double-clicking it. Files come from
File > examples, File > open file, or by dropping them onto a pane; a
file's extension says what it is: .lcd a program (or a library it
includes), .in an interpreter input, .js or .c an extern module's source.

The two selectors beside Run pick, among the open files, the program and
the input. Run interprets that program on that input; Analyze and
Compile work on that program. Every open file is beside the program when
it compiles, so an included library or an extern source is just another
tab. Cmd/Ctrl+Enter runs.

Results go to the output pane's "output" tab. Compile > c instead opens
one tab per generated C file, named as the compiler would write it
(lucidprog.c, or a/lucidprog.c per node of a multi-node program), and
File > save output saves the tab you are looking at.

The examples menu is laid out by examples/index.txt beside the page:
programs, inputs, libraries, externs, tofino programs. Opening a program
also opens its input and the extern sources it names, and selects the
pair for Run. The libraries are the compiler's built-in library, which a
program includes as `include <memops.lcd>;`; a quoted include names an
open tab instead.

Interpreter input
-----------------

The input is one JSON object per line (`#` starts a comment):

    {"port": 1, "event": "count", "args": [1]}      an event on a port
    {"port": 5, "bytes": "0001 00 00000002 0000002a"} a raw packet
    {"get": "hits"}                                  read a global
    {"set": "hits", "index": 0, "value": 9}          write a global's cell
    {"time": 7500}                                   advance the clock
    {"node": "a", ...}                               a line for one node

Time in the interpreter is virtual: an event's stamp is the node's clock
when it was dequeued, a delayed generate is due that many nanoseconds
later, and the delayed events run in time order after the input ends.

Downloading
-----------

File > download lcd.js lets you download the interpreter / compiler 
to your local host, to use with node, e.g., `node lcd.js --help`.

There is also an MCP server that you can start with `node lcd.js mcp` 
(tools lucid_check, lucid_run, lucid_compile, lucid_topology,
lucid_examples; the overview and these examples as resources).
