usage: lcd <cmd> [-v] <file>
  cmds: parse   parse (expanding includes) and pretty-print
        check   parse, resolve, type check; --elab prints the program with inferred types;
                --types prints every expression with its type
        compile check, then lower: inline into the entry points (comptime values substituted,
                loops unrolled, one handler per comptime event argument), assign event tags,
                place handlers on nodes, check global access order; print the result
                --node <name>  print one leaf's program instead of the whole system
                --manifest     print the manifest (tags, ports, links) as JSON instead
                --flows        print, per link, the events sent over it and what the far end accepts
        ir      compile, then print one leaf's program in the lowered IR (--node <name> picks the leaf;
                --flatten after flattening nested events into first-order variants, as the C backend sees it)
        lucid   compile, then print one leaf's program in Lucid, for Lucid's own compilers
                (reference.md, "Compiling to Lucid"): --node <name> picks the leaf of a multi-node
                program; --target tofino|c|switch (default switch) sets the port width
        c       compile, then print one leaf's program in C (through Lucid's C backend):
                --node <name> picks the leaf; --driver rawsock|lpcap|dpdk (default rawsock);
                -o <dir> writes the C file and its makefile there instead of printing
        trace2pcap  turn the JSON input on stdin into one pcap per port in -o <dir> (in_PORT.pcap)
                and ports.txt, the ports to bind; a compiled program and `replay` take them
        replay  interpret pcaps: --interface PORT:IN.pcap:OUT.pcap per port, as a compiled
                program with the pcap driver is run; --recirc-ns N; prints to stdout;
                --auto-bind IN:OUT (patterns with %d) binds any other port the program sends to
        pcapcmp [--bytes|--count] a b  compare two pcaps (bytes and times; bytes only; record counts only); exit 1 at a difference
        stdlib  list the built-in library files (a program includes one as `include <f.lcd>;`);
                stdlib <f.lcd> prints one; stdlib -o <dir> writes them all there
        run     compile, then interpret: JSON packets on stdin, JSON packets on stdout
                --flatten runs the flattened program (nested events as variants; the output must not change)
                input lines: {"port": 1, "bytes": "0a0b0c"}            a packet
                             {"port": 1, "event": "ping", "args": [..]}  an event
                             {"get": "hit_count"}                       print a global
                             {"set": "hit_count", "index": 0, "value": 3}  write a cell
                a multi-node program's lines name their node ("node": "a") and may name a port
  -v    trace execution on stderr (run only)
  --elab  with check: print the elaborated program instead of a summary
  -I dir  also search dir for `include "f";` files (after the including file's directory)
  as lcd.js (the JavaScript build from the playground page): node lcd.js <cmd> ..., the same in one file;
        node lcd.js mcp  serve the compiler to an agent client over MCP (JSON-RPC on stdin/stdout):
                tools lucid_check, lucid_run, lucid_compile, lucid_topology, lucid_examples; the docs
                and examples as resources; for Claude Code: claude mcp add lucid -- node /path/to/lcd.js mcp
