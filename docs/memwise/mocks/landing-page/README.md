# MemWise landing page mockups

These are rough mockups of the public home page, made on 2026-10-20 in the project thread "MemWise landing page".

**Current: v5, "Playbook factory"** (Sandeep, 2026-10-21). Hero "Your playbooks, run like a factory." Sub-line: "Describe the work. Agents write the playbook, build the screens it needs, and run it every day. Your team reviews and maintains quality." New "How the factory works" section: playbooks are the production lines, agents the workers, each line gets its screens, your team is quality control. The factory's output is finished work (onboarded clients, filed documents), not apps; avoid "app" on the page. Standalone file: [memwise-home-v5.html](memwise-home-v5.html); published at https://claude.ai/artifact/Q8cS7Brgx7GemwG2ErPZWy. v5 is not on the design canvas.

**Previous direction: v4, "Playbooks"** (Sandeep, 2026-10-20).
- Headline: "Write a playbook. Agents run it."
- Positioning: the playbook (the expert's own "how we do X" brief) is the product noun and the hook. This is what sets MemWise apart from Zapier-style flow automation.
- Audience: domain experts first, with developers second. No technical words on the main page.
- Look: light, Stripe-like polish, carried over from v3.

## How we got here
v1 was dark and aimed at developers. v2 was light and aimed at domain experts. v3 added polish. v4 reframes the page around playbooks: the playbook document is the hero, there's a playbook library section, and there are no technical words.

## Files

| File | What it is |
|---|---|
| [memwise-home-v5.html](memwise-home-v5.html) | v5 "Playbook factory" (current) as a standalone page. Open it in any browser. |
| [memwise-home-v4.html](memwise-home-v4.html) | v4 "Playbooks" as a standalone page |
| [memwise-home.html](memwise-home.html) | v3 as a standalone page |
| [canvas/Playbook.dc.html](canvas/Playbook.dc.html) | v4 source: "Write a playbook. Agents run it.", playbook-centred hero, playbook library |
| [canvas/Polished.dc.html](canvas/Polished.dc.html) | v3 source, as stored on the design canvas |
| [canvas/Light.dc.html](canvas/Light.dc.html) | v2: the first light version aimed at domain experts |
| [canvas/Main.dc.html](canvas/Main.dc.html) | v1: the first dark version aimed at developers |
| [canvas/canvas.json](canvas/canvas.json) | Layout of the four artboards on the canvas |

The live, editable canvas holding all four versions (private until shared): https://claude.ai/artifact/PdyTwCiSTwKjWi4buRHEDy

The `.dc.html` files only render inside that canvas editor. Use the standalone `.html` files to look at v4 or v3 anywhere else.

## Decisions so far
- Lead with domain experts and make getting started easy. Developer material sits in one band near the bottom.
- Lead with the playbook library, so people see that ready-made playbooks exist. Promise a first draft in minutes.
- The five effect classes are written in plain words: "Look things up", "Prepare", "Update records", "Contact people" and "Can't be undone".
- Fonts are Inter Tight, with Instrument Serif italic for accent phrases. The accent colour is amber (#F5B43C).

## Still placeholders
- Team price ([YOUR PRICE]) and the demo video.
- The tools named in the "Works with" strip (Gmail, Outlook, Sheets, Excel, HubSpot, Xero, Slack) need checking against what we actually support.
- Example names (Northwind Ltd, Priya, Dana Okafor) are made up.
- We wanted ideas from fold.money, but the site couldn't be reached from the cloud environment. Screenshots would let us take ideas from it.
