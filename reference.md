# Lucid Lite Language Reference

Lucid Lite is a language for programming packet-processing switches. A
program parses packets into typed headers, handles events, keeps a little
persistent state, and sends packets out of ports. Everything except header
fields and packet payloads is resolved at compile time, so a program
compiles to straight-line, first-order code.

Programs use the `.lcd` extension. Commands in this reference are written
`lcd <cmd>`, short for `node lcd.js <cmd>`. Run `node lcd.js --help` for
the full list, or see About > commands in the web IDE.

Part 1 covers everything a single-switch program needs. Part 2 covers
structuring larger programs. Part 3 covers multiple switches, externs, and
compiling to C and Lucid.

## Contents

- [Part 1: Writing a program](#part-1-writing-a-program)
  - [A complete program](#a-complete-program)
  - [Running programs](#running-programs)
  - [Declarations](#declarations)
  - [Types](#types)
  - [Statements and expressions](#statements-and-expressions)
  - [Ports and parsers](#ports-and-parsers)
  - [Builtins](#builtins)
  - [Memops](#memops)
  - [Global access order](#global-access-order)
  - [Tables and actions](#tables-and-actions)
- [Part 2: Structuring programs](#part-2-structuring-programs)
  - [Stages](#stages)
  - [Vectors and loops](#vectors-and-loops)
  - [Globals and constructors](#globals-and-constructors)
  - [Passing functions and state](#passing-functions-and-state)
  - [Libraries](#libraries)
  - [Nested events](#nested-events)
- [Part 3: Multiple switches, externs, and compiling](#part-3-multiple-switches-externs-and-compiling)
  - [Nodes and links](#nodes-and-links)
  - [Externs](#externs)
  - [Compiling to C](#compiling-to-c)
  - [Compiling to Lucid](#compiling-to-lucid)

# Part 1: Writing a program

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
handler, which may update state and send packets.

## Running programs

`lcd check prog.lcd` type checks a program. `lcd run prog.lcd < prog.in`
compiles and interprets it, reading one JSON object per line. Lines
starting with `#` are comments, and blank lines are ignored.

```
{"port": 1, "bytes": "000000000002 000000000001 0800 ..."}   a packet arriving on port 1
{"port": 1, "event": "ping", "args": [{"dmac": 2, "smac": 1, "ety": 0}, 3]}
                                                              run an event's handler directly
{"get": "seen"}                                               print a global
{"set": "seen", "index": 0, "value": 9}                       write an array cell
{"time": 7500}                                                advance the clock
{"config": {"recirc_ns": 1000}}                               set the recirculation latency
```

Packet bytes are hex in network order and may contain spaces. Event
arguments are given in order: a record as an object with its fields by
name, a comptime argument by name (`"args": ["seen", 3]`), and a nested
event as `{"event": "e", "args": [..]}`. An integer too large for a
machine integer is written as a string (`"0xffffffffffffffff"`).

Globals are named as in the lowered program (`lcd compile` shows it): an
array inside a global record or vector is `g_a` or `rows_1`.

The output is also one JSON object per line. Each `printf` prints
`{"print": "text"}` as it runs. Each packet sent with `generate_port`
prints its port, its event name, the decoded arguments, and the bytes; a
declared port prints by name (`"port": "out"`). A `get` prints the
global's value. `lcd run -v` traces every parser, handler, read, and
generate on stderr.

**Time.** Every node has a clock in nanoseconds, starting at 0, and an
event is stamped when its node dequeues it. A line may carry `"time": T`,
its arrival time: the clock advances to T, running whatever was due by
then (delayed events, recirculations), and then the line's event is
handled. If T is earlier than the clock, the event is handled at the
clock's value. A line without a time arrives after everything scheduled
so far, including self-generated events, so a program that never mentions
time needs none. A self-generated event arrives after the recirculation
latency (500 ns by default), and an event sent over a link after
`"link_ns"` (0 by default).

What the interpreter runs is the lowered IR, which `lcd ir` prints: one
leaf at a time, first-order and typed, with constants folded, aliases
gone, and every builtin call, generate, and read explicit.

## Declarations

Declarations must appear before they are used. An event must be declared
before its handler and before any use, but the handler may come later.

| Form | Meaning |
|---|---|
| `T x = e;` | A top-level binding: a compile-time value, evaluated once when the program is checked. Usable in match patterns, as a vector length, and as a comptime argument. See [Stages](#stages). |
| `type t = { T f; ... };` | A record type, packed on the wire with no padding. Cannot contain bitstrings. A record containing functions, globals, or `comptime` fields is a comptime record. |
| `type t = T;` | A type alias. |
| `global T x = e;` | Persistent state. `T` must be a global type such as `IntArray.t`, or a record or vector containing one. The initializer runs once, at compile time, and may allocate. See [Globals and constructors](#globals-and-constructors). |
| `event e(params);` | A message. On the wire: a 16-bit tag, then the parameters. |
| `raw event e(params);` | A message with no tag, just the parameters. Used for plain packets. |
| `event e@7(params);` | An event with a fixed tag, for interfacing with the outside world. |
| `handle e(params) { ... }` | The handler for event `e`, with the same parameters. One per event per node. The name may be qualified (`handle proto.resp`). |
| `event e(params) { ... }` | An event declaration and its handler in one. Also with `raw` and `@tag`. |
| `parser p(params) { ... }` | A parser: reads packet bits and transfers control. See [Ports and parsers](#ports-and-parsers). |
| `fun T f(params) { ... }` | A function, inlined at each call. |
| `comptime fun T f(params) { ... }` | A function evaluated at compile time; every parameter and the result are comptime. |
| `memop T f(T m, U x) { ... }` | One atomic read-modify-write on an array cell. See [Memops](#memops). |
| `action R f(I x)(M y) { ... }` | A table action. See [Tables and actions](#tables-and-actions). |
| `port p = Port.create();` | A port of this switch. See [Ports and parsers](#ports-and-parsers). |
| `Port.set_parser(p, f);` | Give port `p` (or every port in a vector) its own entry parser. |
| `link p -- external;`, `link p -- q;`, `link p --> q;` | A port meets the outside, two ports are linked in both directions, or one direction. Every created port must be linked or external. |
| `include <f.lcd>;` | Splice in a built-in library file (`lcd stdlib` lists them: `eth_base.lcd`, `memops.lcd`, `tables.lcd`). A file is included once. |
| `include "f.lcd";` | Splice in your own file, searched for next to the including file and then in `-I` directories. |
| `module m { ... }` | A namespace, whose members are referred to as `m.x`. Modules hold no state. |
| `parser main = p;`, `fun f = e;` | Bind a name to a function-like; sugar for `auto x = e;`. `parser main = p;` makes `p` the entry point. |
| `eventset s = {a, b};` | A named set of events, usable as a type. See [Nested events](#nested-events). |
| `event e(.., event payload);` | An event carrying another event as its last parameter. See [Nested events](#nested-events). |
| `node n { ... }` | A named switch (a leaf) or a group of switches and links (a composite). See [Nodes and links](#nodes-and-links). |
| `port p;`, `global T x;`, `T x;` | A name declared in a composite node without construction, allocated by exactly one leaf inside it. See [Nodes and links](#nodes-and-links). |
| `extern "f.js";`, `extern "f.c";` | The file implementing a module's externs, in JavaScript or C (one language per module). See [Externs](#externs). |
| `extern fun T f(params);` | A function implemented in the module's extern file. |
| `extern global type t;` | An opaque global type whose values are handles owned by the extern file. |
| `extern constr t f(params);` | A constructor of an extern type, callable only in a global initializer or comptime function. |
| `extern parse T f(bitstring pkt, params);` | A custom read for parsers. |
| `Sys.inst_id X = Sys.fresh_inst_id();` | A compile-time id naming a resource shared between nodes. |

## Types

- `bool`, and unsigned integers of any width: `uint8`, `uint16`, `uint32`, `uint48`, `uint128`, and so on.
- `port`: a port of this switch. See [Ports and parsers](#ports-and-parsers).
- `bitstring`: the unread rest of a packet. Only parsers can read it.
- Tuples `(T1, T2)`, written the same way as values: `(a, b)`.
- Records, declared with `type`, built as `t { f = e; ... }`, and accessed as `x.f`.
- `T[n]`: a vector of `n` values of type `T`, where `n` is comptime. See [Vectors and loops](#vectors-and-loops).
- `IntArray.t`: a persistent array of `uint32` cells.
- `ExactTable.t<<K, I, M, R>>`, `TernaryTable.t<<K, I, M, R>>`: match tables. See [Tables and actions](#tables-and-actions).
- `action<<I, M, R>>`: the type of a table action.
- `fun<<T1, T2>>`, `parser<<...>>`, `handle<<...>>`: the types of function-likes, for parameters.
- `event{a, b}`, or a named `eventset`: an event value that is one of the listed events. Bare `event` means any event that does not itself carry a bare `event` parameter. See [Nested events](#nested-events).
- `auto`: let the compiler infer this type. `'h` is an inferred type that must be the same everywhere it appears in one declaration.
- `comptime T`: marks a parameter, local, record field, or function result as holding a compile-time value. This is a stage, not a type. See [Stages](#stages).

Integers are big-endian at their declared width, and arithmetic wraps at
that width. Literals may be decimal or `0x` hex of any length. A `bool`
is one bit. Tuples and records are laid out field by field with no
padding.

## Statements and expressions

```
T x = e;                          declare a local
comptime T x = e;                 declare a comptime local (substituted away)
f(args);                          call a function or builtin
continue p(args);                 transfer control (parsers only; never returns)
return e;   return;               leave a function
match e with                      branch on literals, top-level names, _, and tuples of those
  | 0 -> stmt;
  | (SOME_CONST, _) -> { stmts }
  | _ -> { stmts }
if (c) { stmts } else { stmts }   branch on a boolean; the else is optional
for (i < n) { stmts }             repeat for i = 0 .. n-1; n is comptime, and so is i
{ stmts }                         a block
```

Expressions have integer and boolean literals, `+ - & |`, comparisons,
`&& || !`, field access, tuples, records, calls, vector literals
`[a; b; c]`, comprehensions `[e for i < n]`, indexing `v[i]`, and the
integer cast `(uintN) e`. A cast to a narrower width keeps the low bits,
and a cast to a wider one zero-extends.

## Ports and parsers

**Ports.** A port is a handle, not an integer: `+ - &` and casts on a
port are errors, and `Port.to_int` and `Port.of_int` convert between a
port and its `uint16` number. A program that only needs port numbers can
pass an integer literal to `generate_port` (`generate_port(1, e)`) and
compare with `Port.to_int(ingress_port())`.

To give a port a name, or its own parser, create it at the top level
with `port p = Port.create();`. The interpreter numbers a switch's
created ports from 1, in creation order; those are the numbers to use in
input files. Every created port must be linked to another port or marked
external:

```
port inside = Port.create();     // port 1
port outside = Port.create();    // port 2
link inside -- external;
link outside -- external;
```

**Entry parsers.** Each port has an entry parser. `Port.set_parser(p,
f);` at the top level gives port `p` (or every port in a vector) the
parser `f`, a `parser<<bitstring>>`. It must come after both the port
and the parser, and each port's parser can be set only once. `parser
main` is the parser for every other port, including recirculation. It is
optional: without it, every port runs `continue dispatch_event(pkt)`, so
a program made only of events needs no parser at all.

```
parser from_inside(bitstring pkt) { eth_t eth = read(pkt); continue outbound(eth, pkt); }
parser from_outside(bitstring pkt) { eth_t eth = read(pkt); continue inbound(eth, pkt); }
Port.set_parser(inside, from_inside);
Port.set_parser(outside, from_outside);
```

**What a parser may do.** A parser body is a sequence of bindings
followed by one step. A binding is either `T x = read(pkt);` or `T x =
e;`, where `e` is a variable, a field chain, a literal, or a tuple or
record of those. A step is one of:

- `continue p(args)`, to another parser or to an event, with arguments of the same forms plus the packet;
- `drop()`;
- `match e with` on such a value (or a tuple of them), whose arms are blocks of the same shape.

Parsers have no assignment, `if`, loop, `printf`, `generate`, operator,
cast, or other call, and no `read` outside a binding. Nothing may follow
the step, and every block ends in one. To skip a field, read it into a
local you never use. Functions and parsers may not call each other in a
cycle; only events can loop.

## Builtins

| Builtin | Where | Meaning |
|---|---|---|
| `read(pkt)` | parsers | Read a value of the declared type: `eth_t eth = read(pkt);`. |
| `continue dispatch_event(pkt)` | parsers | Read an event tag and run that event's handler on the parameters that follow. |
| `generate_port(p, e)` | handlers, functions | Serialize event `e` and send it out of port `p`. |
| `generate(e)` | handlers, functions | Serialize event `e` and feed it back into this switch (recirculate), after the current packet. |
| `drop()` | anywhere | Stop processing this packet. |
| `ingress_port()` | anywhere | The port the current packet arrived on. |
| `Sys.time48()`, `Sys.time32()` | handlers, functions | The current event's timestamp in nanoseconds (48 bits, or the low 32). Every read during one event sees the same value. |
| `Event.delay(e, d)` | handlers, functions | Event `e`, sent `d` nanoseconds (32 bits) after the generate that sends it. Only on an event a generate sends directly, never on one nested in another. |
| `printf("fmt", args...)` | handlers, functions | Interpreter output: `%d` an integer, `%b` a boolean, `%%` a percent sign. A string literal can only be a printf argument. |
| `Port.create()` | top-level initializers | A new port of this switch. |
| `Port.to_int(p)`, `Port.of_int(n)` | anywhere | A port's number as a `uint16`, and back. |
| `IntArray.create(n)` | top-level initializers | A new array of `n` zeroed cells; `n` is comptime. |
| `IntArray.get(a, i)`, `IntArray.set(a, i, v)` | handlers, functions | Read or write a cell. |
| `IntArray.setm(a, i, f, x)` | handlers, functions | `a[i] = f(a[i], x)`, for a memop `f`. |
| `IntArray.getm(a, i, f, x)` | handlers, functions | `f(a[i], x)`, leaving the cell unchanged. |
| `IntArray.update(a, i, fget, x, fset, y)` | handlers, functions | Returns `fget(a[i], x)` and sets `a[i] = fset(a[i], y)`, both on the old value. |
| `ExactTable.create(n, [actions], default, arg)` | top-level initializers | A table of `n` entries. Likewise `TernaryTable.create`. |
| `ExactTable.lookup(t, key, marg)` | handlers, functions | Run the first matching entry, or the default. Likewise `TernaryTable.lookup`. |
| `ExactTable.install(t, key, acn, iarg)` | handlers, functions | Append an entry. `TernaryTable.install(t, key, mask, acn, iarg)` also takes a mask. |
| `IntArray.create_shared(id, n)`, `IntArray.open_shared(id, n)` | top-level initializers | An array shared between nodes. Tables have the same pair. See [Externs](#externs). |

Every builtin is also available by its module name (`Sys.generate`,
`Sys.drop`, and so on). A declaration named `generate` shadows the bare
name but never `Sys.generate`.

There is no hash builtin. Key a table on a tuple of fields, or write a
hash as an extern.

## Memops

A switch touches each piece of state once per packet, in one atomic
read-modify-write. A memop is that operation, written as a function:

```
memop uint32 incr(uint32 m, uint32 x) { return m + x; }
memop uint32 max(uint32 m, uint32 x) { if (m < x) { return x; } else { return m; } }

IntArray.setm(counts, i, incr, 1);                       // counts[i] += 1
uint32 old = IntArray.update(peaks, i, get, 0, max, n);  // read the old peak, store max(old, n)
```

A memop takes the cell's current value and one argument, and returns the
cell's type. Its body is a single `return`, or an `if`/`else` whose
branches are such bodies. The expressions may not call anything and may
use each parameter at most once, so the memop compiles to one
instruction. A memop is never called directly; it is passed to `setm`,
`getm`, or `update`. Memops are comptime values, so they can sit in
records and be passed through modules.

The built-in library `memops.lcd` has the common ones: `get`, `put`,
`incr`, `decr`, `max`, and `min`.

## Global access order

A packet passes through the pipeline once, and each global lives in one
stage. So on any control path, a handler may touch each global at most
once, and in declaration order. The compiler checks this after inlining,
so the rule applies across library functions and unrolled loops: a
function that loops over a vector of arrays touches each element once,
and calling it twice in one handler is an error. Different `match` arms
may touch different globals. Arrays inside a global record, and the
elements of a global vector, count separately, ordered by field and by
index. A table lookup and a table install are each an access.

```
handle bump(uint32 i) {
  uint32 n = IntArray.get(hits, i);
  IntArray.set(hits, i, n + 1);       // error: hits accessed twice; use setm
}
```

When a packet needs two passes over the same state, the first handler
generates an event that does the second pass. For example, a handler can
look a key up in a table and, on a miss, generate an install event (see
[Tables and actions](#tables-and-actions)).

## Tables and actions

A table is a match statement whose branches are added at run time. An
`ExactTable.t` compares the whole key, and a `TernaryTable.t` compares
under a mask stored with each entry. An entry holds a key, an action,
and the action's install-time argument. `lookup` runs the first matching
entry (in install order), or the table's default, on the stored argument
and the lookup's match-time argument, and returns the result.

An action has two parameter lists, install-time then match-time, and its
body is one `return` with no calls:

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
array: it counts as one access per packet, and `{"get": "t"}` in an
input prints its entries.

**Installing later.** To install from a handler that has already touched
the table, generate an install event from the built-in library
`tables.lcd`:

```
include <tables.lcd>;
generate(tables.exact_install(t, hit, key, iarg));
generate(tables.ternary_install(pfx, hit, key, mask, iarg));
```

The install runs when the event is handled, after the current packet.
The event carries the table and action as comptime parameters, so each
table-and-action pair gets its own handler and tag, and only the key and
data travel. Because the event recirculates, the switch's recirculation
parser (`main`, or the default) must dispatch tags. `lcd compile
--manifest` lists these events with their tags, for a control program.

Both kinds of table translate to Lucid's `Table.t`. Lucid's Tofino
compiler rejects installs in the data plane, where a control program
installs entries instead, so a program that only looks up compiles for
the Tofino. See examples/table_lib.lcd.

# Part 2: Structuring programs

## Stages

A program has two stages. *Comptime* is when it is compiled: every
top-level binding is evaluated once, in declaration order, and every
function and parser is inlined into `main` and the handlers. *Runtime*
is when packets flow.

Every binding (a parameter, local, record field, or function result)
belongs to one stage. Functions and globals have no runtime form, so a
binding of such a type is always comptime. Any other binding is runtime
unless marked `comptime`. Top-level bindings are comptime without a
marker.

```
uint32 K = 4;                                   // a top-level binding: comptime
fun void f(comptime uint32 n, uint32 x) {..}    // one copy of f per value of n
comptime uint32 next = n + 1;                   // a comptime local
type cfg_t = { comptime uint32 slot; fun<<port, eth_t, bitstring>> send; };
```

A comptime binding must be given a *comptime expression*: a literal; the
name of a function, global, or top-level binding; a comptime parameter
or local; arithmetic on those; or a tuple or record built from them. A
comptime local is never assigned. A record with a function, a global, or
a `comptime` field is a comptime record, so all its fields are comptime.
Comptime values never reach the wire.

A function can return a comptime value, and a call of it is then a
comptime expression that the compiler folds to its value. The function
must return that value on comptime control flow, since a global chosen by
a packet field could not be substituted.

```
comptime fun uint32 plus(uint32 x, uint32 y) { return x + y; }
uint32 K = plus(1, 2);
fun IntArray.t pick(comptime bool second) { if (second) { return b; } else { return a; } }
IntArray.t arr = pick(false);                  // arr is the global a
```

A `comptime fun` like `plus` has no runtime part at all. The compiler
evaluates its calls during type checking, so `K` can size a vector or
bound a loop (`uint32[K] v`, `for (i < K)`). A top-level initializer may
only call such functions. A function with a runtime parameter that
returns a comptime value, like `pick`, is folded only when it is inlined,
so its result can be used as a value but not in a type. `fun comptime T
f(..)` marks only the result as comptime.

`lcd compile` shows the result of inlining: nothing comptime remains.
Handlers are the exception, since an event is generated asynchronously.
An event with a comptime parameter becomes a separate concrete event,
with its own tag and handler copy, for each value it is used with. Such
events cannot have a fixed `@tag`, and an input line injecting one names
the comptime arguments, e.g. `"args": ["seen", 3]`.

## Vectors and loops

A vector `T[n]` holds `n` values of one type, and `n` is comptime: a
literal, a top-level binding, or a comptime parameter or local. Vectors
are built as literals `[1; 5; 6]` or comprehensions `[e for i < n]`, and
read as `v[i]`. They are immutable, and a vector of globals is itself a
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

`for (i < n)` runs its body for `i` from 0 to `n - 1`, with `i` a
comptime local usable as an ordinary integer. A vector index must be a
literal within the vector's length, or a loop variable bounded by that
length, so an index can never be out of range. A length may name a
comptime parameter, as `k` does above, so one function works for any row
count; the checker matches `IntArray.t[k]` only with a vector of exactly
that length. Inlining unrolls every loop and comprehension, so the
lowered program has only literal lengths and indices.

## Globals and constructors

An array is a *handle*: `IntArray.create(n)` runs at comptime and returns
the name of a piece of runtime state. A top-level binding whose type
holds such state (an `IntArray.t`, or a record or vector containing one)
must be declared `global`, and only a global's initializer may allocate.
Each array it allocates becomes a separate piece of state, named after
the global plus the field path when the global is a record or vector.

This is how a module defines its own kind of state: a record type that
holds arrays and comptime parameters, and a constructor, a comptime
function that allocates one. Each `global` of the type is a separate
instance.

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

In the lowered program, `g` and `h` are replaced by four arrays: `g_a`,
`g_b`, `h_a`, and `h_b`. Every field of a global record is comptime, so
`x.n` is usable as a value without a marker; marking it `comptime` also
lets it bound loops and size vectors.

**The creation rule.** `IntArray.create` and `Port.create` are
*creators*: each call makes one handle. A creator may be called only in
a top-level initializer or in the body of a comptime function. A
function that calls a creator (directly or indirectly) is itself
creating, with the same restriction. So a constructor is a comptime
function, a handler can never call one, and everything a program creates
is named. Comptime code creates state but never writes cells, since not
every target can persist initial contents.

## Passing functions and state

Functions, parsers, and globals can be passed as arguments. This is how
modules compose: a lower layer takes the upper layer's parser, an upper
layer takes the lower layer's send function, and a library takes the
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

A `type t = auto;` alias in a module is a single type for the whole
program, chosen by how the module is used; using the module with two
different types is an error.

The usual way to hand a module a whole context in one argument is a
record holding functions together with the state they work on. Its
fields can be called, continued to, and used directly:

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

Such a record can also be a top-level binding (`lib.ctx_t c = lib.ctx_t
{..};`) used by name.

## Libraries

A library is a file of declarations, usually one module, brought in with
`include`. Since function-likes are comptime values, a program can bind a
library's parser as its entry point and a library's function in place of
a builtin:

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

The built-in library `eth_base.lcd` puts an Ethernet header in front of
every tagged event, and its `main` dispatches events and drops
everything else. Inside a library, builtins are written `Sys.generate`,
`Sys.drop`, and so on, so a program's own `generate` binding cannot
capture them. Using a bare builtin name before a binding of that name is
an error. `lcd stdlib f.lcd` prints a built-in library file.

## Nested events

An event may carry another event, and the parameter's type says which
ones: an *event set*, written `event{a, b}` or named with `eventset`. A
constructor application `a(1, 2)` has the singleton type `event{a}`, and
a value fits a parameter when its set is contained in the parameter's.
So `w(3, a(1, 2))` checks against `event w(uint32 d, event{a, b} ev)`,
and `w(3, c(0))` does not.

```
event base1(uint32 x, uint32 y);
event base2(uint32 x, uint32 y);
eventset base = {base1, base2};
event b(uint32 bdst, base ev);
handle b(uint32 bdst, base ev) { generate(ev); }   // ev is one of base1, base2
event c(uint32 cdst, event{b} ev);                  // a b, and only a b
```

The rules:

- An event-typed parameter must be the last one. Like a `bitstring` payload, it is the event's variable-size tail.
- A raw event has no tag and belongs to no set.
- No event may contain itself through its sets. Bare `event`, the largest set, therefore excludes events that carry a bare `event` themselves.
- A local declared `auto` takes the exact set of its initializer, and a parameter declared `auto` accepts any event. A handler's parameter has the same set as the event's.

On the wire, a nested event is its tag and fields, so `b(7, base1(1, 2))`
is `b`'s tag, `7`, `base1`'s tag, `1`, `2`. The interpreter parses a
nested event by its tag, so a handler receives a value it can generate
onward or nest again. Matching on an event value is not supported yet.

The C backend flattens nested events into first-order variants (`lcd ir
--flatten` shows the result, and `lcd run --flatten` runs it, with the
same output). The Lucid backend accepts them only through the framing
library.

# Part 3: Multiple switches, externs, and compiling

## Nodes and links

A program may describe several switches. A `node` is a named top level.
A *leaf* owns globals and ports and handles events; a *composite*
contains nodes and links and owns nothing. A node containing nodes is a
composite, and a program with no `node` is a single leaf. Modules stay
stateless: events shared between nodes are declared in a module, and
each node handles the ones it cares about, over its own state.

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

Neither node declares a parser, so every port dispatches tagged events.
examples/nodes.lcd is a complete multi-node program.

**Ports.** A port belongs to the leaf that created it, and each leaf's
ports are numbered from 1. A composite may name its leaves' ports with
an ordinary binding (`port ctl = ingress.in[0];`), which is the same
handle. `Port.to_int` of another node's port gives a number meaningful
to that port's owner, and `Port.of_int(n)` on a node gives that node's
port `n`. So a node can compute another node's port number and send it
there.

**Links.** A link is an assumption about the cabling: packets leaving
`p` arrive at `q`. It changes no generated code; the deployment must
make it true, and the interpreter does. A link may be declared in any
node containing both ends. A port has at most one incoming and one
outgoing edge. An end may be a vector of ports: `link ifs -- external;`
covers every element, and two vectors of the same length link pairwise.

**Scope.** A node sees its own declarations and those of the nodes
enclosing it; a composite also sees its children's, for aliases and
links. A node never names a sibling's declarations. Anything two sibling
nodes share is declared, without construction, in the node enclosing
both, and allocated by exactly one leaf inside it, which owns it:

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

A declared name must be allocated exactly once, and using it in a
top-level initializer before the allocation is an error. In a leaf's
own program (`lcd compile --node client.ethdriver`), the allocation
becomes an ordinary binding named `client_eth0`.

**Placement.** Only the leaf that owns a global or port may touch it:
read or write the global, or generate on the port. Naming one is not
touching it. A global or port passed as a comptime event argument
selects a handler copy, and `Port.to_int` gives an address. A handler
declared in a leaf runs there. A handler in a shared module, specialized
per comptime argument, runs on the leaf whose state it touches (on every
leaf if it touches none; it may not touch two).

**Entry parsers.** `Port.set_parser` works as on a single switch, but
only the owner of a port may set its parser. The leaf's real entry point
is derived: a match on `ingress_port()` with one arm per port that has
its own parser, and the declared `main` as the default.

**Coverage.** Every tagged event generated on a port must be accepted at
the other end of its link: by the parser there, which accepts the events
its leaf handles when it dispatches, and anything when it reads a layout
first. Raw events and ports chosen at runtime are not checked. A packet
whose event has no handler on the node it reaches is dropped at run
time.

**Tools.** `lcd compile` lowers the whole system as one program (tags
are shared, and each handler is specialized once). `lcd compile --node
a` prints one leaf's program, an ordinary single-node program in which
every link's far end is `external`. `lcd compile --manifest` prints the
tags, each leaf's ports (name, number, and kind: self, linked, or
external) and globals, and the links, as JSON. `lcd compile --flows`
prints, per link, the events sent and what the far end accepts, and per
node, what it generates to itself and what its recirculation parser
accepts.

**Running.** `lcd run` runs every leaf in one process, with each link as
a queue. Each input line names its node, and may name a port:

```
{"node": "a", "port": "ctl", "event": "start", "args": [3]}
{"node": "a", "get": "s_req_ct"}            or {"get": "s_req_ct"} when the name is unique
```

Output lines carry `"node"` too, and a packet leaving on a linked port is
delivered to the other end instead of printed. A global allocated under
a name declared in an enclosing node is named like `a_st_ct` (or
`"a.st_ct"`).

## Externs

A module may declare functions it does not define, implemented in a
JavaScript or C file that the module names:

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

Externs are called from handlers and functions, not from parsers or
top-level initializers. Values cross the boundary by value: `bool`,
`uintN`, and records, tuples, and vectors of those. The result may be
`void`. Vector lengths in a signature must be literals or top-level
bindings. examples/hash.lcd, examples/hash.js, and examples/hash.c are a
complete example.

**Extern state.** A module may own state the language never sees
inside: an `extern global type`, whose values are handles. A constructor
makes one in a global initializer, and the module's functions take it as
a parameter. Passing a handle counts as an access to that global for the
[access order](#global-access-order) check.

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

A function takes at most one handle, only a constructor returns one (of
its own module's type), and a handle never sits inside a record or
vector.

**Payloads.** An `extern fun` with a `bitstring` parameter is a
transform: called from a handler, it gets the rest of the packet and may
change its bytes in place, but not its length. A generate afterwards
sends the changed bytes, and a transform after a generate has already
sent the payload is an error. An `extern parse` is a custom read, for a
header the language cannot describe: `vx.hdr h = vx.read_hdr(pkt);`
hands the extern the packet at the cursor, and the extern advances the
cursor by what it consumed or reports a malformed packet, which is
dropped. Both start on a byte boundary: the event parameters before a
payload, and the reads before a custom read, must total whole bytes.

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

**Sharing between nodes.** A constructor that takes a `Sys.inst_id`
creates a resource under that id, and an `extern fun` that takes the id
and returns the handle type opens it from another node. The id is a
compile-time integer minted once with `Sys.fresh_inst_id()`, in a
binding both nodes see. The checker requires exactly one constructor
call per id.

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

Every node's constructors run before any node's openers. The interpreter
guarantees this, and a deployment of compiled programs must start them
in the same two phases. JavaScript modules share through `lucid.shared`,
a table every node sees. C modules share through shared memory named by
the id, using `lucid_shm_create` and `lucid_shm_open` from the generated
`lucid_rt.h`.

The builtin arrays and tables share the same way:
`IntArray.create_shared(id, n)` in one node and `IntArray.open_shared(id,
n)` in another name one array, and `ExactTable.create_shared(id, n,
[actions], default, arg)` with `ExactTable.open_shared` (same arguments)
name one table; `TernaryTable` works likewise. The opener repeats the
creator's arguments, since each node lays the resource out from them,
and the checker requires them to match. Every node may read and write a
shared resource.

**JavaScript modules** run in the interpreter, in both lcd.js and the web
IDE (open the file as a tab; every open file is visible to the program
when it compiles). The file is a CommonJS module that exports a table of
functions, or a factory that takes the node's name and returns one, so
its closure holds that node's state:

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

An integer arrives as a number (a decimal string past 2^53), a bool as a
boolean, a record as an object with its fields by name, and a tuple or
vector as an array. Results come back the same way and are checked
against the declared type. An extern constructor may return any value,
which is handed back as the handle argument. A JavaScript error is a
runtime error with its stack. In a payload function, the payload is
`{bytes, pos}`: `bytes` is a `Uint8Array` of the rest of the packet, and
a custom read sets `pos` to the number of bytes it consumed, or returns
`null` for a malformed packet.

**C modules** are linked into the compiled program; lcd.js and the web
IDE cannot run them. `lcd c -o dir` writes a header (`hashes.h`) with
prototypes derived from the declarations (`uint32_t hashes_mix(uint32_t
x, uint32_t y);`, a record as `typedef struct {..} hashes_pair;`, a
vector as `lucid_arr_uint32_3` with fields `_0`, `_1`, `_2`, and a
`bool` as `uint8_t`), copies the module's source beside `lucidprog.c`,
and writes a makefile that compiles both. A definition that disagrees
with its declaration is a C compile error. An extern type is `typedef
struct Acl_t_s *Acl_t;` in the header, the module's C defines the
struct, and the program constructs its globals in `lucid_init()` before
the first packet. A payload is `lucid_bs {ptr, len}`: by value for a
transform, and by pointer for a custom read, which advances `ptr` and
`len` or calls `lucid_parse_error()`.

## Compiling to C

`lcd c prog.lcd` prints one leaf as a C program for Lucid's C backend,
choosing a packet driver with `--driver`: `rawsock` (raw sockets, the
default), `lpcap` (pcap files), or `dpdk`. `-o dir` writes `lucidprog.c`,
the runtime header, and a makefile. Use `--node name` for one leaf of a
multi-node program.

The C path does not require the Lucid subset below: per-port parsers,
drops anywhere in a handler, record and tuple event parameters, and
nested events (flattened first) all compile. Integers wider than 64 bits
have no C type and are rejected. Every event's fields must total whole
bytes, so prefer `uint8` to `bool` in data that travels in an event,
such as a table action's argument used with `tables.exact_install`.

To check compiled C against the interpreter, turn an input into per-port
pcaps with `lcd trace2pcap -o dir < prog.in`, run the program built with
the `lpcap` driver on them, run the interpreter on the same pcaps with
`lcd replay`, and compare the outputs with `lcd pcapcmp`.

## Compiling to Lucid

`lcd lucid prog.lcd` prints the program in Lucid, for one leaf of a
multi-node program with `--node name`. `--target tofino|c|switch`
(default `switch`) sets the width of a port number. The output compiles
with Lucid's interpreter, C compiler, and Tofino compiler, and the Lucid
Lite interpreter is byte-compatible with Lucid's three targets. For
that, the program must stay in the *interop subset*:

- Tagged events are generated only through the framing library,
  `eth_base.generate(ev)` and `eth_base.generate_port(p, ev)`, which put
  Lucid's Ethernet header (ethertype 666) in front of the tag, as Lucid
  does for its own background events. Raw events are Lucid's packet
  events and are generated bare with `generate_port`.
- `main` starts with the library's entry: `parser main = eth_base.main;`,
  or `eth_base.start(next, pkt)` with the program's own parser after the
  header.
- No `Port.set_parser`, no event-typed parameters (except the library's
  own), no self-generated raw events, no arithmetic in parsers, and
  `drop()` in a handler only as its last statement.

Each violation is reported with what to use instead. In the output,
every port is a `symbolic int` named after the port (`client_to_server`),
bound at deploy time. `lcd compile --manifest` lists each port's
symbolic name, its interpreter number, and its kind.
