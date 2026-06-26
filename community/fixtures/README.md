# 🍝 Found a routing mistake? Tell us!

When LLMSpaghetti sends your message to the wrong AI model that's called
a misroute. You can help fix it for everyone — no coding required.

---

## The easy way — use the web form

In LLMSpaghetti: **Settings → Report routing mistake**

Fill in what you typed, where it went, where it should have gone.
We handle the rest. No technical knowledge needed.

The form generates the fixture automatically and opens a PR for you.

---

## The manual way — add a line to a file

If you're comfortable editing text files, add one line to the right file
in the `contributed/` folder and open a Pull Request.

Copy this template and fill in the blanks:

```json
{
  "message": "WHAT YOU TYPED",
  "expected": "WHERE IT SHOULD HAVE GONE",
  "got": "WHERE IT ACTUALLY WENT",
  "had_file": false,
  "note": "ONE SENTENCE EXPLAINING WHY"
}
```

### Fill in each field

**`message`** — exactly what you typed in the chat.
Edit out any personal information before sharing.
Example: `"give me a quick summary of this contract"`

**`expected`** — the role it should have gone to.
Pick one from this list:

| Role | When to use it |
|---|---|
| `image` | You wanted an image generated |
| `code` | You were asking about programming |
| `reasoning` | You wanted deep thinking or planning |
| `fast` | A quick simple question |
| `document` | Summarising or analysing a file |
| `general` | Anything else |

**`got`** — the role it actually went to (same list above).
You can see this in the "answered by X" label under each response.

**`had_file`** — did you have a file attached when you sent this?
`true` or `false`

**`note`** — one sentence explaining why you think `expected` is right.
Example: `"had a PDF open, the word quick sent it to fast instead"`

### Real example

```json
{
  "message": "give me a quick summary of this contract",
  "expected": "document",
  "got": "fast",
  "had_file": true,
  "note": "had a PDF open, the word quick sent it to fast instead"
}
```

### Which file to put it in

```
contributed/
  image-routing.jsonl      ← image generation mistakes
  document-vs-fast.jsonl   ← "quick summary" type mistakes
  code-edge-cases.jsonl    ← code questions that look general
  multilingual.jsonl       ← non-English message mistakes
  general.jsonl            ← anything else
```

Not sure which file? Put it in `general.jsonl`. We'll move it if needed.

**Don't worry about:**
- The `id` field — we assign that on review
- Getting the file perfect — we'll help sort it out
- Breaking something — you can't break anything by adding a line

---

## What happens after you contribute

1. We review it — is it a real misroute? Is it anonymised?
2. We merge it — now every LLMSpaghetti install tests against your case
3. We use it to improve the classifier — misroutes like yours get fixed
4. Next release ships better routing for everyone

Your one line of JSON helps everyone who uses LLMSpaghetti.

---

## Privacy

Your message content will be visible publicly on GitHub once merged.

**Before contributing:**
- Remove any personal information (names, emails, company details)
- Replace sensitive content with placeholders like `[COMPANY]` or `[NAME]`
- The web form has a built-in anonymisation step

We never collect fixtures automatically. Contributing is always opt-in.

---

## Questions?

Open a [Discussion](../../../discussions) — not an Issue.
Issues are for bugs. Discussions are for questions.

Thank you. 🍝
