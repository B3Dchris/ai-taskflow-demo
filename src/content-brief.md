# Content brief: no-gi BJJ technique pages for "Road to Blue"

You are writing technique data for a personal no-gi Brazilian jiu-jitsu training app. The app already has 57 white→blue-belt techniques (list in `existing-techniques.txt` next to this file). You are writing the techniques for ONE later belt stage. Accuracy matters more than flourish: a real student will drill from these steps.

## Output

Write ONE file (path given in your task) containing exactly two JavaScript declarations and nothing else:

```js
const TECH_<BELT>=[
T("id","Name","category","from","to","priority",
 ["Step 1.","Step 2.","Step 3.","Step 4."],          // 4–6 steps, imperative, concrete body positions
 ["Key detail 1.","Key detail 2."],                    // exactly 2
 ["Common mistake 1.","Common mistake 2."],            // exactly 2
 "Drill: one concrete drill with reps or rounds.",
 ["next_id","next_id"],                                // 1–3 ids this chains into (existing ids or ids in YOUR file)
 "Optional safety/rules warning, or omit this argument entirely"),
...
];
const OV_<BELT>={
 id:"Two sentences: what it is, then when to use it.",
 ...
};
```

See `format-example.txt` for a real entry and its OV line. Match that voice: plain, direct, second person ("you", "they"), short sentences, no em-dashes, no hype, no emoji. Describe sides as near/far or by the arm/leg involved, not left/right, unless the technique truly needs it.

## Allowed values

- **id**: lowercase snake_case, unique, NOT already in `existing-techniques.txt`.
- **category**: one of `takedown, entry, guard, sweep, pass, escape, control, sub, back`
- **priority**: `core` (every student at this stage should have it), `key` (important), `plus` (bonus)
- **from / to**: one of these 20 position ids ONLY (map sub-positions onto the closest one, and name the sub-position in the technique name, e.g. "X-guard technical stand-up sweep" from `bfly_bot` or `seated`). `to` may also be `sub` for a submission finish.
  - `standing` both standing · `seated` seated/open guard bottom (also DLR, RDLR, X-guard, K-guard, SLX entries) · `open_top` passing open guard (top) · `bfly_bot` butterfly guard bottom · `cg_bot` closed guard bottom · `cg_top` in their closed guard · `hg_bot` half guard bottom (incl. deep half, lockdown) · `hg_top` half guard top · `sc_top` side control top (incl. knee on belly, north-south top) · `sc_bot` under side control · `mount_top` · `mount_bot` · `back_top` you have their back (incl. crucifix, truck) · `back_bot` your back taken · `turtle_top` · `turtle_bot` · `fhl_top` you have front headlock · `fhl_bot` you're in their front headlock · `ashi` you're attacking a leg entanglement (ashi garami, outside ashi, saddle/inside sankaku, 50/50) · `ashi_def` your leg is entangled

## Safety and rules

Add the warning argument to every heel hook, knee reap, kneebar, toe hold, calf slicer, and any move that is banned in common rule sets below a certain belt. State the rule plainly, e.g. "IBJJF no-gi allows heel hooks and knee reaping only at brown and black belt; ADCC and most submission-only events allow them. Follow your gym's rules." Never include slams, spinal locks or neck cranks presented as finishes. Every submission step list ends with a slow, controlled finish.

## Before you finish

Run `node -e 'function T(...a){return a}; <paste your file content>; console.log(TECH_<BELT>.length, Object.keys(OV_<BELT>).length)'` (or equivalent) to confirm it parses, that every technique has an OV entry, and that every id in `nx` exists either in `existing-techniques.txt` or your file. Fix anything that fails. Reply with just the file path, the count, and any technique you were unsure about.
