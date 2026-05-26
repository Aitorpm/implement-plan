# Serial Smoke Test

A trivial single-phase test. Creates one file and verifies it contains the expected content.
Run from any directory that is a git repo.

phases:
  - id: 1
    name: "Smoke Test"
    mode: serial
    model: haiku
    allowed_tools: [Write, Read]
    tasks:
      - Create a file called smoke-test-output.txt containing exactly the text "hello from phase 1" (no quotes, no extra whitespace)
    verify:
      - "test -f smoke-test-output.txt"
      - "grep -q 'hello from phase 1' smoke-test-output.txt"
