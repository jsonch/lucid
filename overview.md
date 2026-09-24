# Lucid Lite

Lucid Lite is a language for programming a packet-processing switch.
A program parses incoming packets into typed headers, handles events, keeps
a little persistent state, and sends packets out of ports. Everything that
is not a header field or a packet payload is resolved at compile time, so a
program compiles down to straight-line, first-order code.

Files use the `.lcd` extension. The tool is `lcd`:

```
lcd check prog.lcd        type check
lcd compile prog.lcd      print the lowered program (functions inlined, comptime values substituted, loops unrolled)
lcd ir    prog.lcd        print the lowered IR (per leaf): what the interpreter runs
lcd run   prog.lcd        interpret; packets in and out as JSON lines on stdin/stdout
lcd lucid prog.lcd        print the program in Lucid (one leaf of a multi-node program with --node)
lcd c     prog.lcd        print the program in C (Lucid's C backend, our copy; -o dir writes the files)
lcd stdlib                list the built-in library files (`include <f.lcd>;`); `lcd stdlib f.lcd` prints
                          one, `lcd stdlib -o dir` writes them all
lcd ir --flatten f.lcd    the IR after nested events are flattened into first-order variants
lcd run --flatten f.lcd   run the flattened program (the output must not change)
make playground           the compiler and interpreter as a web page, site/index.html, and the
                          command line as a node script, site/lcd.js (`node lcd.js check f.lcd`;
                          the library is built in, so it is one file; the page offers it for download).
                          Open files are tabs in two panes (draggable between them) over the
                          output pane, whose "output" tab takes every result but Compile > c's,
                          which opens a tab per generated C file (a/lucidprog.c per node); the
                          selectors beside Run pick the program and the input among the files. File > examples lists site/examples/ (copied from programs/examples/ by
                          make) in the sections its index.txt lays out ([programs], [inputs],
                          [libraries], [externs], [tofino programs]: a label, then the files);
                          drop a file in and add its line. The libraries section is the
                          compiler's built-in library (`lcd stdlib`), not files of the directory. About > readme opens src/playground/readme.md,
                          the page's own guide. The page is scriptable: `lcd.run(program, input)` and the other
                          exports, `playground.open/select/command/getResult` and the rest, and
                          stable ids on the menu entries (documented at the top of
                          src/playground/playground.js)
lcd -I dir ...            also search dir for included files
node site/lcd.js mcp      the compiler as an MCP server for an agent client (JSON-RPC on stdin/stdout):
                          tools lucid_check, lucid_run, lucid_compile, lucid_topology, lucid_examples,
                          and the docs and examples as resources; .mcp.json registers it for Claude Code
                          (after `make playground`)
```


## A complete program

```
include <memops.lcd>;

uint16 PING_ETY = 0x666;

type eth_t = { uint48 dmac; uint48 smac; uint16 ety; };

global IntArray.t seen = IntArray.create(16);

// A background event: carried inside a packet, tagged so it can be dispatched.
event ping(eth_t eth, uint32 n);

handle ping(eth_t eth, uint32 n) {
  IntArray.setm(seen, n, memops.incr, 1);
  match n with
    | 0 -> drop();
    | _ -> generate_port(ingress_port(), ping(eth, n - 1));
}

// A raw event: no tag, just the fields. Used for packets leaving as-is.
raw event passthrough(eth_t eth, bitstring payload);

handle passthrough(eth_t eth, bitstring payload) {
  generate_port(1, passthrough(eth, payload));
}

parser main(bitstring pkt) {
  eth_t eth = read(pkt);
  match eth.ety with
    | PING_ETY -> continue dispatch_event(pkt);   // a tagged event follows the header
    | _ -> continue passthrough(eth, pkt);
}
```

A packet arrives at `main`. The parser reads headers, decides where the
packet goes, and transfers control with `continue`. Control ends in a
handler, which may update state and emit packets.

## Declarations

| Form | Meaning |
|---|---|
| `module m { ... }` | A namespace. Refer to members as `m.x`. Modules hold no state. |
| `node n { ... }` | A named top level: a *leaf* (owns globals and ports, has a `main`, runs on one device) or a *composite* (contains nodes and links). See "Nodes, ports, and links". |
| `link p --> q;`, `link p -- q;`, `link p -- external;` | A directed edge between two ports, both directions, or the statement that a port meets the outside. An assumption about the cabling; changes no code. An end may be a vector of ports: every element to the outside, or two vectors of one length pairwise. A link may appear in any node containing both ends. |
| `include <f.lcd>;` | Splice the declarations of the built-in library file `f.lcd` here (`lcd stdlib` lists them: `eth_base.lcd`, `memops.lcd`, `tables.lcd`; the library is compiled into every binary). A file is included once. |
| `include "f.lcd";` | The same for a file of your own: searched next to the including file, then in `-I` directories. Never the built-in library. |
| `extern fun T f(params);` | A function implemented outside the language, in the module's source file; called like a function. See "Externs". |
| `extern "f.js";`, `extern "f.c";` | The file implementing a module's externs, JavaScript (run by the interpreter) or C (linked into the compiled program). One language per module. |
| `extern global type t;` | An opaque global type of the module: its values are handles, made by the module's constructors in global initializers and passed to its functions. See "Externs". |
| `extern constr t f(params);` | A constructor of the module's extern type: a creator, callable in a global initializer (or a comptime function) only. |
| `extern parse T f(bitstring pkt, params);` | A custom read: a parser binds a local to it (`T x = m.f(pkt, ..);`) and it advances the cursor, or drops the packet. See "Externs". |
| `Sys.inst_id X = Sys.fresh_inst_id();` | An instance id: a compile-time integer naming a resource one node's constructor creates and other nodes open. See "Externs". |
| `T x = e;` | A top-level binding: a compile-time value, evaluated once when the program is checked. Usable in match patterns, as a vector length, and as a comptime argument. See "Stages". |
| `parser main = p;`, `fun f = e;` | Bind a name to a function-like; sugar for `auto x = e;`. `parser main = p;` makes `p` the entry point. |
| `type t = { T f; ... };` | A record type. Packed on the wire, no padding. Cannot contain bitstrings. May contain functions, globals, and `comptime` fields, in which case values of it are comptime (see below). |
| `type t = T;` | A type alias. |
| `global T x = e;` | Persistent state, at the top level of a leaf. `T` must be a global type such as `IntArray.t`, or a record or vector containing one, and such a type must be declared `global`. The initializer is a comptime computation that may allocate; it is evaluated once, at compile time. See "Globals and constructors". |
| `port p = Port.create();` | A port of this leaf: a comptime handle, like an array, whose number is assigned outside the program. See "Nodes, ports, and links". |
| `port p;`, `global T x;`, `T x;` | A name declared without construction, in a node whose inner nodes share it: exactly one leaf inside allocates it with `p = Port.create();` (`x = ..;`) at its top level and owns what it creates; the others see the name by scope. A node never names a sibling's declarations. |
| `Port.set_parser(p, f);` | A configuration call at a leaf's top level: packets arriving on port `p` (or on every port of a vector) go to parser `f`, a `parser<<bitstring>>`. Owner only, once per port. See "Parsers and main". |
| `event e(params);` | A message. On the wire: a 16-bit tag, then the parameters. |
| `raw event e(params);` | A message with no tag: just the parameters. Used for plain packets leaving the switch. |
| `event e(.., event payload);` | An event parameter of event type is another event, serialized after the others (its tag, then its fields). It must be the last parameter. See "Nested events". |
| `eventset s = {a, b};` | A named event set: the type of a value that is one of the events `a` or `b`. Usable wherever a type is (`event w(uint32 d, s ev);`). See "Nested events". |
| `event e@7(params);` | An event with a fixed tag, for interfacing with the outside world. |
| `handle e(params) { ... }` | The handler for event `e`, which may be qualified (`handle proto.resp`). Same parameters as the event. One per event per node. |
| `event e(params) { ... }` | Shorthand for the event declaration followed by its handler, as in Lucid. Also with `raw` and `@tag`. |
| `parser p(params) { ... }` | A parser: reads packet bits and transfers control. A leaf's `main` (optional) is the parser for every port not given one by `Port.set_parser`, recirculation included; absent, it is `continue dispatch_event(pkt)`. |
| `fun T f(params) { ... }` | A function. Inlined at each call. |
| `comptime fun T f(params) { ... }` | A comptime function: every parameter and the result are comptime, and calls are evaluated while the program is checked. |
| `memop T f(T m, U x) { ... }` | A memop: one atomic read-modify-write on an array cell. See "Memops". |

Declarations must appear before they are used. An event must be declared
before its handler and before any use; the handler itself may come later.

## Types

- `bool`, `uint8`, `uint16`, `uint32`, `uint48` (any `uintN`).
- `port`: a port of this device. A handle created by `Port.create()` at comptime, or a runtime value from `ingress_port()` or `Port.of_int`. Never on the wire: an event parameter of type `port` must be `comptime`.
- `bitstring`: the unread remainder of a packet. Only parsers can read it.
- Tuples `(T1, T2)`, written the same way as values: `(a, b)`.
- Records, declared with `type`, built as `t { f = e; ... }`, accessed as `x.f`.
- `event{a, b}`: an event value that is one of the events `a` or `b` (an *event set*); `eventset s = {a, b};` names one, and `s` is then a type. Bare `event`: any event that does not itself carry a bare `event` parameter. See "Nested events".
- `fun<<T1, T2>>`, `parser<<...>>`, `handle<<...>>`: the type of a function-like, used for parameters.
- `IntArray.t`: a persistent array of `uint32` cells.
- `ExactTable.t<<K, I, M, R>>`, `TernaryTable.t<<K, I, M, R>>`: a match table with keys of type `K` (a tuple for several), entries that store an install-time argument of type `I` and an action, lookups that take a match-time argument of type `M` and return `R`. See "Tables and actions".
- `action<<I, M, R>>`: the type of an action, the function stored in a table entry.
- `auto`: let the compiler infer this type. `'h` is an inferred type that must be the same everywhere `'h` appears in one declaration.
- `comptime T`: on a parameter, local, record field, or function result, marks a binding that holds a compile-time value. Not a type: a stage on the binding. See "Stages" below.
- `T[n]`: a vector of `n` values of type `T`. `n` is a literal, a top-level binding, or a comptime parameter or local in scope. See "Vectors and loops" below.

Integer values have no width limit of their own: `uint128` and wider
work, literals may be decimal or `0x` hex of any length, and arithmetic
wraps at the declared width. In JSON input a value beyond a machine
integer is given as a string (`"0xffffffffffffffff"`), and output
prints such values as digit strings.

Integers are big-endian at their declared width; a `bool` is one bit.
Tuples and records are laid out field by field with no padding.

## Nested events

An event may carry another event, and the parameter's type says which
ones: an *event set*, written `event{a, b}` or named with `eventset`.
A constructor application `a(1, 2)` has the singleton type `event{a}`,
and a value fits a parameter when its set is within the parameter's, so
`w(3, a(1, 2))` checks against `event w(uint32 d, event{a, b} ev)` and
`w(3, c(0))` does not. Bare `event` is the largest set: every event
that does not itself carry a bare `event` parameter (`notes/event_sets.md`
says why: a set may not contain an event that contains it, and bare
`event` would otherwise contain every such event). A local declared
`auto` takes the exact set of its initializer; a parameter declared
`auto` accepts any event. A handler's parameter carries the same set as
the event's.

```
event base1(uint32 x, uint32 y);
event base2(uint32 x, uint32 y);
eventset base = {base1, base2};
event b(uint32 bdst, base ev);
handle b(uint32 bdst, base ev) { generate(ev); }   // ev is one of base1, base2
event c(uint32 cdst, event{b} ev);                  // a b, and only a b
```

The rules: an event-typed parameter is the last one (like a `bitstring`
payload, it is the event's variable-size tail, and a chain of nested
events has one tail); a raw event has no tag and is not a member of any
set; no event contains itself through its sets. On the wire a nested
event is its tag and fields, so `b(7, base1(1, 2))` is `b`'s tag, `7`,
`base1`'s tag, `1`, `2`. The interpreter parses a nested event by its
tag, so a handler receives a value it can generate onward or nest again;
in JSON input an argument that is an event is written
`{"event": "base1", "args": [1, 2]}`. Matching on an event value is not
yet a feature. The C compiler takes nested events by flattening them
into first-order variants first (`lcd ir --flatten` shows the result;
`notes/event_sets.md`); the Lucid printer does not take them outside
the framing library.

## Statements

```
T x = e;                          declare a local
comptime T x = e;                 declare a comptime local (substituted away)
f(args);                          call a function or builtin
continue p(args);                 transfer control (parsers only, never returns)
return e;   return;               leave a function
match e with                      branch; patterns are literals, top-level names, _, and tuples of those
  | 0 -> stmt;
  | (SOME_CONST, _) -> { stmts }
  | _ -> { stmts }
for (i < n) { stmts }             repeat for i = 0 .. n-1; n is comptime, i is a comptime local
if (c) { stmts } else { stmts }   branch on a boolean; the else is optional
{ stmts }                         a block
```

Expressions have integer and boolean literals, `+ - & |`, comparisons,
`&& || !`, field access, tuples, records, calls, vector literals
`[a; b; c]`, comprehensions `[e for i < n]`, indexing `v[i]`, and the
integer cast `(uintN) e`: to a narrower width it keeps the low bits, to
a wider one it zero-extends; a cast of a comptime value folds. A `port`
is not an integer: `+ - & |` on a port and a cast of a port are errors;
`Port.to_int` and `Port.of_int` convert.

### What a parser may do

A parser body is Lucid's parser sub-language, checked before typing: a
sequence of bindings, then one step. A binding is `T x = read(pkt);`
or `T x = e;` with `e` a variable, a field chain, a literal, or a tuple
or record of those. A step is `continue p(args)` to a parser or an
event (the arguments in the same forms, plus the packet), `drop()`, or
`match e with` on such a value (a tuple of them too) whose arms are
blocks of the same shape. No assignment, `if`, loop, `printf`,
`generate`, operator, cast, or other call, no `read` outside a binding,
nothing after the step, and every block ends in one. A read into a
local that is never used is how a field is skipped. Functions and
parsers may not call each other in a cycle; only events break cycles.

## Builtins

| | Where | Meaning |
|---|---|---|
| `read(pkt)` | parsers | Read a value of the declared type from the packet: `eth_t eth = read(pkt);` |
| `continue dispatch_event(pkt)` | parsers | Read an event tag and run that event's handler on the parameters that follow. |
| `generate_port(p, e)` | handlers, functions | Serialize event `e` and send it out of port `p`. |
| `generate(e)` | handlers, functions | Serialize event `e` and feed it back into `main`, after the current packet. |
| `drop()` | anywhere | Stop processing this packet. |
| `ingress_port()` | anywhere | The port the current packet arrived on. |
| `Sys.time48()`, `Sys.time32()` | handlers, functions | The current event's timestamp in nanoseconds: the node's clock when it dequeued the event (48 bits, the Tofino's width; or its low 32 bits, Lucid's `Sys.time()`). Every read during one event sees the same value. See "Time" under "Running programs". |
| `Event.delay(e, d)` | handlers, functions | Event `e` with a delay of `d` nanoseconds (32 bits): the generate that sends it lets it go `d` later. Only on the event a generate sends directly, never on one carried inside another; the framing library's `generate_delay(ev, d)` and `generate_port_delay(p, ev, d)` delay the framed packet. |
| `Port.create()` | top-level initializers | A new port of this leaf. A creator, like `IntArray.create`: the value is a handle, and the number behind it is assigned by binding (or by the interpreter). |
| `Port.to_int(p)`, `Port.of_int(n)` | anywhere | A port's number as a `uint16`, and back. The number is meaningful to the port's owner, wherever it was computed: `of_int` on a node gives that node's port with that number. So a node may compute another node's port number (naming the port, not touching it) and send it there. |
| `Sys.generate(e)` etc. | anywhere | The same builtins by their module name. A declaration named `generate` shadows the bare name but never `Sys.generate`. |
| `printf("fmt", args...)` | handlers, functions | Interpreter output, as a `{"print": ..}` line: `%d` an integer, `%b` a boolean, `%%` a percent sign. A string literal is only ever a printf argument. |
| `IntArray.create(n)` | top-level initializers | A new array of `n` zeroed cells; `n` is comptime. A creator: see the creation rule under "Globals and constructors". |
| `IntArray.create_shared(id, n)`, `IntArray.open_shared(id, n)` | top-level initializers | An array shared between nodes under an instance id: created in one node, opened in others with the same arguments. Tables have the same pair. See "Externs". |
| `IntArray.get(a, i)`, `IntArray.set(a, i, v)` | handlers, functions | Read and write a cell. |
| `IntArray.setm(a, i, f, x)` | handlers, functions | `a[i] = f(a[i], x)` for a memop `f`. |
| `IntArray.getm(a, i, f, x)` | handlers, functions | `f(a[i], x)`, leaving the cell unchanged. |
| `IntArray.update(a, i, fget, x, fset, y)` | handlers, functions | Returns `fget(a[i], x)` and sets `a[i] = fset(a[i], y)`, both on the old value. |
| `ExactTable.create(n, [actions], default, arg)` | top-level initializers | A table of `n` entries; `actions` are the actions entries may hold, `default` the action run when nothing matches, with install-time argument `arg`. Likewise `TernaryTable.create`. |
| `ExactTable.lookup(t, key, marg)` | handlers, functions | Run the first entry matching `key` (its action on its stored argument and `marg`), or the default. Likewise `TernaryTable.lookup`. An access. |
| `ExactTable.install(t, key, acn, iarg)` | handlers, functions | Append an entry: `key` runs `acn` on `iarg`. `TernaryTable.install(t, key, mask, acn, iarg)` matches only the bits set in `mask`. An access. |

## Tables and actions

A table is a match statement whose branches are added at run time.
Two kinds, by how keys match: `ExactTable.t` compares the whole key,
`TernaryTable.t` compares under a mask stored with each entry. An
entry holds a key, an action, and the action's install-time argument;
`lookup` runs the first entry that matches (entries in install order),
or the table's default action, on that stored argument and the
lookup's match-time argument, and returns the result.

An action is Lucid's: a function with two parameter lists, install-time
then match-time, whose body is one call-free `return`:

```
type res_t = { uint32 val; bool found; };
action res_t hit(uint32 x)(uint32 a) { return res_t { val = x + a; found = true; }; }
action res_t miss(uint32 unused)(uint32 a) { return res_t { val = a; found = false; }; }

global ExactTable.t<<uint32, uint32, uint32, res_t>> t = ExactTable.create(4, [hit; miss], miss, 0);
global TernaryTable.t<<(uint32, uint16), uint32, uint32, res_t>> pfx = TernaryTable.create(4, [hit; miss], miss, 0);

handle put(uint32 k, uint32 v) { ExactTable.install(t, k, hit, v); }
handle get(uint32 k, uint32 a) { res_t r = ExactTable.lookup(t, k, a); }
handle put_prefix(uint32 k, uint16 p, uint32 v) { TernaryTable.install(pfx, (k, p), (0xffffff00, 0), hit, v); }
```

An action is passed by name, never called. A table is a global like an
array, so it lives in a leaf, may sit in a module's state record, and
counts as one access per packet for the order check; an install is an
access too. `lcd run` prints a table's entries with `{"get": "t"}`.

Both kinds print to Lucid's one `Table.t`, the ternary install as
`Table.install_ternary`. Lucid's Tofino compiler rejects an install in
the data plane (entries come from a control program there); a program
that only looks up compiles.

An asynchronous install is an event, from `programs/stdlib/tables.lcd`:
`generate(tables.exact_install(t, hit, key, iarg))` and
`tables.ternary_install(t, acn, key, mask, iarg)`. The event carries the
table and the action as comptime parameters, so each table-and-action
pair gets its own handler copy and tag, with only the key and the data
on the wire; the install runs when the event is handled, after the
current packet. `lcd compile --manifest` lists these instances per node
with their tags and what they are bound to, for a control program. The
event goes through recirculation like any tagged event, so the node's
recirculation parser (main's default arm) must dispatch tags; the
coverage check reports a self-generated event the default arm cannot
accept, and `--flows` prints each node's recirculation line. A node
that wants a custom layout to itself keeps it on an explicit loopback
port (`Port.set_parser` and a self-link).

## Memops

A switch touches each piece of state once per packet, in one atomic
read-modify-write. A memop is that operation, written as a function:

```
memop uint32 incr(uint32 m, uint32 x) { return m + x; }
memop uint32 max(uint32 m, uint32 x) { if (m < x) { return x; } else { return m; } }

IntArray.setm(counts, i, incr, 1);                       // counts[i] += 1
uint32 old = IntArray.update(peaks, i, get, 0, max, n);  // read the old peak, store max(old, n)
```

A memop takes the cell's current value and one argument and returns the
cell's type. Its body is a single `return`, or an `if`/`else` whose
branches are such bodies; the expressions may not call anything and may
use each parameter at most once, so the memop compiles to one instruction.
A memop cannot be called directly; it is passed to `setm`, `getm`, or
`update`. Memops are comptime values, so they can sit in records and be
passed through modules like any function. `programs/stdlib/memops.lcd` has the
common ones: `get`, `put`, `incr`, `decr`, `max`, `min`.

This is Lucid's design, kept as is so that programs translate directly.
Reading a cell with `get` and writing it back with `set` in the same
handler is two accesses, which a pipeline cannot do; use a memop.

## Global access order

A packet passes through the pipeline once, and each global lives in one
stage, so a handler may touch each global at most once on any control
path, and in declaration order. The compiler checks this after inlining,
where every access is explicit, so the rule applies across library
functions and unrolled loops: a function that loops over a vector of
arrays touches each element once, and calling it twice in one handler
is an error. Different `match` arms may touch different globals. Arrays
inside a global record, and elements of a global vector, count
separately, ordered by field and by index.

```
handle bump(uint32 i) {
  uint32 n = IntArray.get(hits, i);
  IntArray.set(hits, i, n + 1);       // error: hits accessed twice; use setm
}
```

When a packet needs two passes over the same state, the first handler
generates an event for the second: `sketch.lcd` adds to its rows in one
event and queries them in another.

## Passing functions and state

Function-likes and globals can be passed as arguments. This is how modules
compose: a lower layer takes the upper layer's parser as an argument, an
upper layer takes the lower layer's send function, a library takes the
array it should operate on.

```
module ip {
  type underlay_t = auto;                              // whatever headers sit below ip
  type send_t = fun<<port, (underlay_t, ip_t), bitstring>>;

  event process(send_t send, underlay_t under, ip_t ip, bitstring payload);

  parser start(send_t send, underlay_t under, bitstring pkt) {
    ip_t ip = read(pkt);
    continue process(send, under, ip, pkt);
  }

  handle process(send_t send, underlay_t under, ip_t ip, bitstring payload) {
    send(1, (under, ip), payload);
  }
}
```

## Stages

A program has two stages. *Comptime* is when it is compiled: every
top-level binding is evaluated then, once, in declaration order, and
every function and parser is inlined into `main` and the handlers.
*Runtime* is when packets flow. Every binding (a parameter, a local, a
record field, a function result) belongs to one stage. Functions and
globals have no runtime form, so a binding of such a type is comptime
whether it says so or not; a binding of any other type is runtime unless
marked `comptime`. Top-level bindings are comptime by position and take
no marker.

```
uint32 K = 4;                                   // a top-level binding: comptime
fun void f(comptime uint32 n, uint32 x) {..}    // one copy of f per value of n
comptime uint32 next = n + 1;                   // a comptime local
type cfg_t = { comptime uint32 slot; fun<<port, eth_t, bitstring>> send; };
```

A comptime binding must be given a *comptime expression*: a literal, the
name of a function, global, or top-level binding, a comptime parameter
or local, arithmetic on those, or a tuple or record built from them. A
comptime local is used like a parameter and never assigned. A record
with a function, a global, or a `comptime` field is a comptime record:
every value of it is a comptime expression, so its other fields are
comptime too. Comptime values never reach the wire.

A function may return a comptime value, and a call of it is then a
comptime expression: the compiler inlines the call and folds it to the
value. The function must return the value on control flow that is
itself comptime, since a global chosen by a packet field could not be
substituted.

```
comptime fun uint32 plus(uint32 x, uint32 y) { return x + y; }
uint32 K = plus(1, 2);
fun IntArray.t pick(comptime bool second) { if (second) { return b; } else { return a; } }
IntArray.t arr = pick(false);                  // arr is the global a
```

A `comptime fun`, like `plus`, has every parameter and its result
comptime: it has no runtime part at all, and the compiler evaluates
calls of it while type checking, so `K` can also size a vector or bound
a loop (`uint32[K] v`, `for (i < K)`). A top-level initializer may only
call such functions. A function with a runtime parameter that returns a
comptime value, like `pick`, is only folded when it is inlined, so its
result can be used as a value but not in a type. `fun comptime T f(..)`
marks just the result.

In exchange, the compiler inlines every function and every parser into
`main` and the handlers, substituting comptime values as it goes, so
nothing comptime remains at run time; `lcd compile` shows the result. A
handler is different: its event is generated asynchronously, so an event
with a comptime parameter becomes one concrete event, with its own tag
and its own copy of the handler, per value it is used with. For that
reason such events cannot be given a fixed `@tag`. Injecting such an
event through `lcd run` names the comptime arguments, e.g. `"args":
["seen", 3]`.

A record holding a function together with the state it works on is the
usual way to hand a whole context to a module in one argument. Its fields
can be called, continued to, and used directly:

```
module lib {
  type ctx_t = { fun<<port, eth_t, bitstring>> send; IntArray.t counts; };

  event process(ctx_t ctx, eth_t eth, uint32 idx, bitstring pl);

  handle process(ctx_t ctx, eth_t eth, uint32 idx, bitstring pl) {
    IntArray.setm(ctx.counts, idx, memops.incr, 1);
    ctx.send(1, eth, pl);
  }
}

parser main(bitstring pkt) {
  eth_t eth = read(pkt);
  lib.ctx_t c = lib.ctx_t { send = send_same; counts = a; };
  continue lib.process(c, eth, 0, pkt);
}
```

A record of functions can also be a top-level binding,
`lib.ctx_t c = lib.ctx_t {..};`, and used by name.

A `type t = auto;` alias inside a module is one type for the whole
program, chosen by how the module is used. Using the module with two
different types is an error.

## Globals and constructors

An array is a *handle*: `IntArray.create(n)` runs at comptime and hands
back the name of a piece of runtime state, which the lowered program
declares as a global of its own. A top-level binding whose type holds
such state (an `IntArray.t`, or a record or vector containing one) is
written `global`, and only a global's initializer may allocate. The
initializer is evaluated at compile time, once, and every array it
allocates becomes a piece of state named after the global, with the
field path appended when the global is a record or a vector. The
global's name then stands for its value, a comptime record or vector
over those arrays, and is used like any other comptime value.

This is how a module defines its own kind of state: a record type
holding arrays together with comptime parameters, and a constructor, a
comptime function that allocates it. Each `global` of the type is a
separate instance.

```
module foo {
  type t = { IntArray.t a; IntArray.t b; comptime uint32 n; };

  comptime fun t create(uint32 n) {
    return t { a = IntArray.create(n); b = IntArray.create(n); n = n; };
  }

  fun void bump(t x, uint32 i) {
    for (j < x.n) { .. }                     // x.n is comptime: it can bound a loop
    IntArray.setm(x.a, i & (x.n - 1), memops.incr, 1);
  }
}

global foo.t g = foo.create(4);
global foo.t h = foo.create(2);
```

`lcd compile` shows the result: `g` and `h` are gone, and in their place
are `global IntArray.t g_a = IntArray.create(4);`, `g_b`, `h_a`, `h_b`.
Every field of a global record is comptime, since the whole record was
built at compile time, so `x.n` needs no `comptime` marker to be usable
as a value; marking it `comptime` lets it bound loops and size vectors.

**The creation rule.** `IntArray.create` and `Port.create` are
*creators*: each call makes one handle. A creator may be called in a
top-level initializer of a leaf, or in the body of a comptime function.
A function that calls a creator, or a creating function, is itself
*creating*, and a creating function may be called only from a top-level
initializer or another comptime function. So a constructor is a comptime
function, a handler cannot call one (it would create state per packet),
and everything a top-level initializer creates ends up in its value with
a name. Comptime code creates state and computes values; it never writes
cells, since not every target can persist initial contents.

## Nodes, ports, and links

A program may describe several switches. A `node` is a named top level:
a *leaf* owns globals and ports and handles events; a *composite*
contains nodes and links and owns nothing. Which one a node is follows
from its body (a node containing nodes is a composite). A program with
no `node` is one leaf. Modules stay stateless: events shared between
nodes are declared in a module, and each node handles the ones it cares
about, over its own state.

```
module proto { event req(uint32 i); event resp(uint32 i, uint32 r); }

node a {
  port ctl = Port.create();
  port link_b = Port.create();
  global sender.t s = sender.create(link_b);
  event start(uint32 i) { sender.send_req(s, i); }          // generate_port(s.to_recv, proto.req(i))
  handle proto.resp(uint32 i, uint32 r) { sender.on_resp(s, i, r); }
}
node b {
  port link_a = Port.create();
  global receiver.t r = receiver.create(link_a);
  handle proto.req(uint32 i) { receiver.on_req(r, i); }   // generate_port(r.to_sender, proto.resp(i, i + 1))
}

link a.ctl -- external;
link a.link_b -- b.link_a;
```

Neither node declares a parser: every port dispatches tagged events
(below, "Parsers and main").

A **port** is a handle, created at comptime by `Port.create()` like an
array by `IntArray.create`, and bound to a physical number outside the
program. A port belongs to the leaf that created it; the interpreter
numbers each leaf's ports from 1. A composite may *name* its leaves'
ports with an ordinary binding, `port ctl = ingress.in[0];`, which is
the same handle.

**Scope.** A node sees the declarations of the nodes enclosing it and
its own; a composite also sees its children's (for aliases and links).
A node never names a sibling's declarations. What two sibling nodes
share is declared in the node enclosing both, without construction, and
allocated by exactly one leaf inside it, which owns what it creates:

```
node client {
  port eth0;                                  // declared here: app and ethdriver both see the name
  global LucidEth.t lucid_eth;

  node ethdriver {
    eth0 = Port.create();                     // allocated here: ethdriver owns it
    lucid_eth = LucidEth.create(client_mac);
    ..
  }
  node app {
    port down = Port.create();
    event send_req() {
      // eth0's number is an address the driver understands; lucid_eth in
      // an event selects the driver's handler copy. Neither is touched.
      generate_port(down, LucidEth.tx(lucid_eth, Port.to_int(eth0), AppCommon.req(0)));
    }
  }
  link app.down -- ethdriver.up;
}
```

A declared name must be allocated by one leaf inside the declaring node,
once; using it in a top-level initializer before the allocation is an
error. In the lowered program the two forms stay; in a leaf's own
program (`lcd compile --node client.ethdriver`) the allocation is an
ordinary binding named `client_eth0`, and the interpreter accepts the
dotted name too.

A **link** is an assumption about the cabling: packets leaving `p`
arrive at `q`. It defines no values and changes no generated code; the
deployment must make it true, and the interpreter does. A link may be
declared in any node containing both ends. Every port is accounted for:
linked, or stated `external`; a port has at most one incoming and one
outgoing edge. An end may be a vector of ports: `link ifs -- external;`
covers every element, and two vectors of one length link pairwise.

**Parsers and main.** Each port has an entry parser. `Port.set_parser(p,
f);` at a leaf's top level gives port `p` (or every port of a vector)
the parser `f`, a `parser<<bitstring>>`; only the owner may set it, once
per port. A leaf's `parser main` is the parser for every port not given
one, recirculation included, and it is optional: absent, it is
`continue dispatch_event(pkt)`, so a program of events alone declares no
parser. The node's real main is derived, a match on `ingress_port()`
with one arm per port that has its own parser and the declared main as
the default; no match is emitted when no port differs.

```
port[2] ifs = [Port.create() for i < 2];
port up = Port.create();
LucidEth.t e = LucidEth.create(ifs, up, mac);
parser rx(bitstring pkt) { continue LucidEth.rx(e, pkt); }   // needs e, so it comes after e
Port.set_parser(ifs, rx);                                     // frames on the interfaces
                                                              // up: dispatches
```

The call comes after both the port and the parser exist, which is what
lets the parser take the instance that holds the port.

**Placement.** A global or port is touched only by code of the leaf that
owns it: reading or writing a global, generating on a port. Naming one
is not touching it: a global or port as a comptime event argument
selects a handler copy, and `Port.to_int` of a port gives its number, an
address meaningful to the owner. A handler declared in a leaf runs
there; a handler in a shared module, specialized per comptime argument,
runs on the leaf whose state it touches (on every leaf if none, and it
cannot touch two).

**Coverage.** Every tagged event generated on a port must be accepted at
the far end of its link: by the parser the port there has, which
accepts the events its leaf handles when it dispatches, and anything
when it reads a layout first (that layout is not modelled). A raw event
is bytes and is not checked; a port chosen at runtime is not tracked.
`lcd compile --flows` prints the table: per node, what it generates to
itself and what its recirculation parser accepts; per link, the events sent and
what the far end accepts. A packet whose event has no handler on the
node it reaches is dropped at run time.

`lcd compile` lowers the whole system as one program (tags are shared,
handlers are specialized once) and prints it with the `node` blocks;
`lcd compile --node a` prints one leaf's program, an ordinary
single-node program whose links say `external` for every far end and
in which another leaf's port number is the literal the interpreter
assigns; `lcd compile --manifest` prints the tags, each leaf's ports
(with the symbolic that names each in Lucid, its number, and its kind:
self, linked, external) and globals, the link table, and the external
ports as JSON. `lcd run` runs
every leaf in one process with each link as a queue. Worked examples:
`programs/tests/features/multinode/`.

## Externs

A module may declare functions it does not define, implemented in
JavaScript or C in a file the module names (`notes/externs.md`):

```
module hashes {
  extern "hash.js";                      // or "hash.c"
  type pair = { uint32 a; uint32 b; };
  extern fun uint32 mix(uint32 x, uint32 y);
  extern fun pair swap(pair p);
  extern fun uint32 sum(uint32[3] xs);
}

handle go(uint32 x, uint32 y) {
  uint32 m = hashes.mix(x, y);
  hashes.pair p = hashes.swap(hashes.pair { a = x; b = y; });
}
```

An extern is called from handlers and functions (not parsers, which
only read, and not top-level initializers, which run at compile time).
What crosses the boundary is `bool`, `uintN`, and records, tuples, and
vectors of those, by value; the result may be `void`. Vector lengths
in the signature are literals or top-level bindings.

A module may also own state the language never sees the inside of: an
**extern global type**, whose values are handles. A constructor makes
one in a global initializer, and the module's functions take the handle
as a parameter, which counts as an access to that global for the order
check (once per packet, in declaration order, like an array):

```
module Acl {
  extern "acl.c";
  extern global type t;
  extern constr t create(uint32 n);
  extern fun void install(t acl, uint32 key, uint32 val);
  extern fun uint32 lookup(t acl, uint32 key);
}

global Acl.t allow = Acl.create(4);
global Acl.t deny = Acl.create(2);

handle get(uint32 k) { printf("%d %d", Acl.lookup(allow, k), Acl.lookup(deny, k)); }
```

A function takes at most one handle; only a constructor returns one,
and only of its own module's types; a handle never sits inside a
record or vector.

Externs can also work on the **payload**. An `extern fun` with a
`bitstring` parameter is a transform: from a handler it gets the rest
of the packet and may change the bytes in place (not the length); a
generate afterwards sends the changed bytes, and a transform after a
generate that already sent the payload is an error. An `extern parse`
is a custom read for parsers, for a header the language does not
describe: `vx.hdr h = vx.read_hdr(pkt);` hands the extern the packet at
the cursor, which it advances by what it consumed, or it reports a
malformed packet and the packet is dropped. Both start on a byte
boundary: an event's parameters before its payload total whole bytes,
and so do the reads before a custom read.

```
module vx {
  extern "vxlan.js";
  type hdr = { uint8 flags; uint32 vni; };
  extern parse hdr read_hdr(bitstring pkt);
  extern fun void xor_payload(bitstring pkt, uint8 key);
}
parser main(bitstring pkt) { eth_t eth = read(pkt); vx.hdr h = vx.read_hdr(pkt); continue tunneled(eth, h, pkt); }
handle tunneled(eth_t eth, vx.hdr h, bitstring payload) { vx.xor_payload(payload, 0x55); generate_port(2, tunneled(eth, h, payload)); }
```

In JavaScript a payload is `{bytes, pos}`: `bytes` a `Uint8Array` of
the rest of the packet, `pos` the cursor a custom read sets to the
bytes it consumed; a custom read returns `null` for a malformed
packet. In C it is `lucid_bs {ptr, len}`, by value for a transform and
by pointer for a custom read, which advances `ptr` and `len` or calls
`lucid_parse_error()`; both are declared in the generated header.

An extern global can be **shared between nodes**. A constructor that
takes a `Sys.inst_id` creates the resource under that id; an `extern
fun` that takes the id and returns the handle type opens it from
another node. The id is a compile-time integer, minted once for the
program with `Sys.fresh_inst_id()` in a binding both nodes see:

```
module Acl {
  extern "shared_acl.c";
  extern global type t;
  extern constr t create(Sys.inst_id id, uint32 n);
  extern fun t open(Sys.inst_id id);
  extern fun uint32 lookup(t acl, uint32 key);
}
Sys.inst_id ACL = Sys.fresh_inst_id();
node a { global Acl.t acl = Acl.create(ACL, 4); .. }
node c { global Acl.t acl = Acl.open(ACL); .. }
```

Every node's constructors run before any node's openers, in the
interpreter and in the compiled programs alike: `scripts/lucid_launch.py`
starts the nodes' programs and holds them at a barrier between the two
phases (and `--sequential` runs them one after another, for pcap
replays). The checker requires exactly one constructor call per id
in the program. In JavaScript the modules share through `lucid.shared`,
a table every node sees; in C through shared memory named by the id,
with `lucid_shm_create` and `lucid_shm_open` from the generated
`lucid_rt.h`.

The builtin arrays and tables share the same way: `IntArray.create_shared(id,
n)` in one node and `IntArray.open_shared(id, n)` in another name one
array, and `ExactTable.create_shared(id, n, [actions], default, arg)` with
`ExactTable.open_shared(id, n, [actions], default, arg)` one table
(`TernaryTable` likewise). The opener repeats the creator's arguments,
since each node's program lays the resource out from them, and the
checker requires them to match. Every node may read and write a shared
resource; the interpreter keeps one value for it, the compiled programs
one shared-memory segment. In JavaScript a constructor returns any value, which
the host keeps and hands back as the handle argument. In C the type is
`typedef struct Acl_t_s *Acl_t;` in the generated header, the module's
C defines the struct, and the compiled program constructs its globals
in `lucid_init()` before the first packet.

A **JavaScript** module (`extern "hash.js";`) runs in the interpreter:
in the node script and the playground page (open the file as a tab,
File > open file or drop it on a pane; every open file is beside the
program when it compiles). The file is a CommonJS module whose
export is a table of functions, or a factory taking the node's name and
returning one, so its closure is that node's state:

```
module.exports = function (node) {
  let calls = 0;
  return {
    mix(x, y) { calls++; return ((x * 31) ^ y) >>> 0; },
    swap(p) { return { a: p.b, b: p.a }; },
    sum(xs) { return xs.reduce((s, x) => s + x, 0); },
  };
};
```

An integer arrives as a number (a decimal string past 2^53), a bool as
a boolean, a record as an object with its fields by name, a tuple or
vector as an array; a result comes back the same way and is checked
against the declared type. The native `lcd` runs it in an embedded
QuickJS (`console.log` prints to stderr); `node site/lcd.js` and the
page run it themselves. A JavaScript error is a runtime error with its
stack.

A **C** module (`extern "hash.c";`) is linked into the compiled program:
`lcd c -o dir` writes a header `hashes.h` with the prototypes derived
from the declarations (`uint32_t hashes_mix(uint32_t x, uint32_t y);`,
a record as `typedef struct {..} hashes_pair;`, a vector as
`lucid_arr_uint32_3` with fields `_0`, `_1`, `_2`, a `bool` as
`uint8_t`) and copies `hash.c` beside `lucidprog.c`; the makefile
compiles both. A definition that disagrees with its declaration is a
C compile error. The native `lcd` runs a C module too: it compiles the
sources with `cc` into a shared object, one copy per node so static
state is per node as in the compiled program, and calls into it, so
the interpreter runs the same C the program links. The node script and
the page cannot run C modules.

## Libraries

A library is a file of declarations, usually one module, brought in with
`include`. Since function-likes are comptime values, a program can bind a
library's parser as its entry point and a library's function in place of
a builtin, and the boilerplate disappears from the program:

```
include <eth_base.lcd>;
parser main = eth_base.main;        // the library's parser is the entry point
fun generate = eth_base.generate;   // and its framing-aware generate replaces the builtin

event foo(uint32 i);

handle foo(uint32 i) {
  match i with
    | 0 -> drop();
    | _ -> generate(foo(i - 1));
}
```

`programs/stdlib/eth_base.lcd` is that library: an ethernet header in front of every
tagged event, and a `main` that dispatches events and drops everything
else. Inside the library, the builtins are written `Sys.generate`,
`Sys.drop`, and so on, so that the program's `generate` binding cannot
capture the library's own calls. Using a bare builtin name in code that
comes before a binding of that name is an error.

## Vectors and loops

A vector `T[n]` holds `n` values of one type. Its length is comptime: a
literal, a top-level binding, or a comptime parameter or local. Vectors
are built as literals `[1; 5; 6]` or comprehensions `[e for i < n]`, and
read as `v[i]`. They are immutable; a vector of globals is itself a
global.

```
uint32 K = 3;

global IntArray.t[K] rows = [IntArray.create(8) for i < K];
uint32[K] masks = [7; 3; 1];

fun void add(comptime uint32 k, IntArray.t[k] rows, uint32[k] masks, uint32 key) {
  for (i < k) {
    uint32 idx = (key + i) & masks[i];
    IntArray.setm(rows[i], idx, memops.incr, 1);
  }
}

handle process(eth_t eth) { add(K, rows, masks, eth.key); }
```

`for (i < n)` runs its body for `i` from 0 to `n - 1`; `n` is comptime
and `i` is a comptime local, usable as an ordinary integer. An index into
a vector must be a literal within a known length, or a loop variable
whose bound is the vector's length; nothing else, so an index can never
be out of range. A length may name a comptime parameter, as `k` does
above, so a function can work for any row count. At a call the length is
whatever the comptime argument is; the checker matches `IntArray.t[k]` only with a
vector of exactly that length. Inlining unrolls every loop and
comprehension and substitutes the index, so the lowered program has
only literal lengths and indices.

## Compiling to Lucid

`lcd lucid prog.lcd` prints the lowered program in Lucid, for one leaf
of a multi-node program with `--node name`; `--target tofino|c|switch`
(default `switch`) sets the width of a port number. A program has to be
in the *interop subset* (`notes/lucid_translation.md`, Part A), which
makes the lowered program map to Lucid one construct to one and makes
the interpreter byte-compatible with Lucid's three targets:

- tagged events are generated only through the framing library:
  `eth_base.generate(ev)` and `eth_base.generate_port(p, ev)` put
  Lucid's ethernet header (ethertype 666) in front of the tag, which is
  what Lucid does itself for its background events, so the translation
  drops the framing and uses Lucid's builtins; raw events are Lucid's
  packet events and go through `generate_port` bare;
- `main` starts with the library's entry (`parser main = eth_base.main;`,
  or `eth_base.start(next, pkt)` with the program's own parser after the
  header): Lucid's entry parser reads the header, dispatches on its
  ethertype, and hands the rest to the program;
- no `Port.set_parser`, no event-typed parameter (only the library's
  `raw_pkt` nests an event), no self-generated raw event, no arithmetic
  in a parser, `drop()` in a handler only as the last statement.

Each restriction reports what to use instead, and each names a Lucid
feature that would lift it. In the output every port is a `symbolic
int` named after the port (`client_to_server`), bound at deploy time:
`lcd compile --manifest` lists, per port, that name, the interpreter's
number, and its kind (self, linked to a named far end, external), and
`scripts/lucid_deploy.py` turns the manifest and a device binding into
each leaf's `.symb` file and its `lucidSwitch --interface` command line.
`programs/tests/lucid/` holds programs with their expected Lucid; the outputs
compile with Lucid's interpreter, C compiler, and Tofino compiler.

## Compiling to C

`lcd c prog.lcd` prints one leaf as a C program for Lucid's C backend,
which lives in this tree as our own copy (`src/ccore/`); `--driver`
picks the packet driver (raw sockets by default, or pcap files, or
DPDK), `-o dir` writes `lucidprog.c` and its makefile. Unlike `lcd
lucid`, this path does not require the interop subset: per-port parsers,
drops anywhere in a handler, and record or tuple event parameters all
compile. An event carried inside an event, which is what the interop
library's `generate` does, is flattened into first-order variants first
(`lcd ir --flatten` shows them; `notes/event_sets.md`), so those
programs compile too, and `scripts/pcap_test.sh` replays a program
through the compiled C against the interpreter. Integers wider than 64
bits have no C container and are rejected.

## Running programs

`lcd run` reads one JSON object per line:

```
{"port": 1, "bytes": "000000000002 000000000001 0800 ..."}   a packet arriving on port 1
{"port": 1, "event": "ping", "args": [{"dmac": 2, "smac": 1, "ety": 0}, 3]}
                                                                run an event's handler directly
{"get": "seen"}                                                 print a global
{"set": "seen", "index": 0, "value": 9}                         write an array cell
```

Globals are named as in the lowered program: an array inside a global
record or vector is `g_a` or `rows_1`; one allocated under a name
declared in an enclosing node is `a_st_ct` (`"a.st_ct"` is accepted).

In a multi-node program a line names its node, and a port may be named:

```
{"node": "a", "port": "ctl", "event": "start", "args": [3]}
{"node": "a", "get": "s_req_ct"}            or {"get": "s_req_ct"} when the name is unique
```

Output lines then carry `"node"` too, a packet leaving on a linked port
is delivered to the far end instead of printed, and a declared port
prints by name (`"port": "out"`).

Time. Every node has a clock in nanoseconds from 0, and an event is
stamped when its node dequeues it. An input line may carry `"time": T`,
its arrival time: the clock advances to T, running whatever was due by
then (delayed events, recirculations), and the event is handled; if T
is earlier than the node's clock the event is handled at the clock's
value. A line with only a time, `{"time": T}`, advances the clock the
same way. Lines without a time arrive after everything scheduled so
far, so a program that never mentions time runs as it always did. A self-generated event arrives
after the recirculation latency, 500 ns unless a `{"config":
{"recirc_ns": N}}` line sets it; a linked one after `"link_ns"` (0).

Each `printf` in the program prints `{"print": "text"}` as it runs.

Each packet sent with `generate_port` is printed as a JSON object with the
port, the event name, its decoded arguments, and the bytes. Comptime
arguments to an injected event are given by name, e.g. `"args": ["seen", 3]`.
`lcd run -v` traces every parser, handler, read, and generate.

What runs is the lowered IR, which `lcd ir` prints: one leaf at a time,
first-order and typed, with the framing library's calls spliced in,
constants folded, aliases gone, tuple matches split into one scrutinee
per component, and every builtin call, generate, and read explicit. The
Lucid printer reads the same IR, so the two agree by construction.
