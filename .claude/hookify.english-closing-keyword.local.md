---
name: block-french-closing-keyword
enabled: true
event: bash
action: block
conditions:
  - field: command
    operator: regex_match
    pattern: gh\s+(pr|issue)\s+(create|edit|comment)|git\s+commit
  - field: command
    operator: regex_match
    pattern: (?i)\b(ferme|referme|corrige|r[ée]sout|r[ée]soud|r[eè]gle|cl[oô]t|cl[oô]ture|r[ée]pare)(nt|s|z)?\s+(l[ea]\s+|l[\'’]\s*)?(issue\s+|ticket\s+)?#\d+
---

🚫 **A French closing keyword closes nothing.**

You are about to write something like `Ferme #191` / `Corrige #191` / `Résout #191`
into a PR body, a comment or a commit message. **GitHub only parses English
keywords.** The PR will merge, the issue will stay open, and nobody will notice
until someone audits the tracker — this repo has already paid for it once, on
PR #192.

**Use one of these instead, on its own line:**

```
Closes #191
```

`Closes` / `Fixes` / `Resolves` all work (plus `Close`, `Fix`, `Resolve`,
`Closed`, `Fixed`, `Resolved`). Nothing else does.

**This is not the repo's French-prose rule contradicting itself.** The keyword is
read by a machine, so it follows the code's language, not the prose around it.
The rest of your PR body stays in French — only the closing line is English:

> Cette PR corrige le défaut relevé en revue.
>
> Closes #191

**If you were only *referring* to an issue, not closing it** — rephrase so the
verb is not adjacent to the number (`corrige le défaut relevé en #191`), which is
both accurate and outside this rule.

**Known false positive, and its way out.** A shell command that merely *quotes*
the wrong form as data — a test, a `grep`, a heredoc writing a contract that
warns about this very mistake — trips the rule, because the pattern sees one flat
command string and cannot tell quotation from intent. This rule is `event: bash`
only, so the way out is to stop routing that text through the shell: write the
file with the Write or Edit tool instead of `cat <<'EOF'`. That is the right
habit anyway for anything longer than a line.
