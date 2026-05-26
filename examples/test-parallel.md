# Parallel Smoke Test

Two teammates each create a separate file. Tests worktree creation, parallel execution,
file copy, commit, and post-parallel verify. Run with --sequential to avoid double quota.

phases:
  - id: 1
    name: "Parallel Smoke Test"
    mode: parallel
    model: haiku
    teammate_A:
      name: "File A Writer"
      branch: "smoke/teammate-a"
      files:
        - output-a.txt
      tasks:
        - Create output-a.txt containing exactly the text "teammate A was here"
      verify: "grep -q 'teammate A was here' output-a.txt"
    teammate_B:
      name: "File B Writer"
      branch: "smoke/teammate-b"
      files:
        - output-b.txt
      tasks:
        - Create output-b.txt containing exactly the text "teammate B was here"
      verify: "grep -q 'teammate B was here' output-b.txt"
    post_parallel_verify:
      - "test -f output-a.txt"
      - "test -f output-b.txt"
      - "grep -q 'teammate A was here' output-a.txt"
      - "grep -q 'teammate B was here' output-b.txt"
