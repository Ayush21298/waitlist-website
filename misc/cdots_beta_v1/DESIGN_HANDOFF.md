# C·Dots Teaser — Design Handoff

Single-screen beta signup page (Korean), for laptop & tablet.
All values below are in **design px** on a **1920×1080 canvas**.
In code: `1rem = 10 design px`, scaled by `--s = min(100vw/1100, 100vh/1080)`
(height-driven — the composition is identical on any landscape screen).

---

## 1. Layout

Vertical stack, horizontally centered:

| Element | Value |
|---|---|
| Top padding | 70 (grows to center the block on tall/portrait screens) |
| Logo height | 56 (width auto, `logo.svg` ratio 814:248) |
| Logo → Heading | 40 |
| Heading → Subtitle | 12 |
| Subtitle → Input pill | 56 |
| Pill → Counter | 30 |
| Background image | pinned to viewport bottom, centered, width 1920; crops equally left/right on narrow screens; top 90px masked with a linear fade |

## 2. Color tokens

| Token | Hex | Usage |
|---|---|---|
| `text/primary` | `#0C0C0E` | Heading, counter number |
| `text/secondary` | `#B4B4BB` | Subtitle, "자리 남음" label |
| `text/tertiary` | `#9A9AA1` | "/100" |
| `text/placeholder` | `#B9B9C0` | Input placeholder |
| `text/input` | `#222222` | Typed email |
| `border/input` | `#E7E7EC` | Pill border (focus: `#C9C9D4`) |
| `button/idle` | `#DFDFE5 → #C9C9D2` (vertical gradient) | Arrow button, empty field |
| `button/active` | `#3A3A40 → #0C0C0E` | Arrow button, field has text |
| `state/error` | border `#F5A45C`, text `#D8823C`, button `#F6BD85 → #EC9C55` | Invalid email |
| `state/success` | text `#4B8F5F`, button `#7BC98F → #5AA871` | Registered |
| `background` | `#FFFFFF` | Page (glow is baked into the bg image) |

## 3. Typography

| Style | Font | Weight | Size | Extras |
|---|---|---|---|---|
| Heading | One UI Sans | 700 | 72 | ls −2%, lh 1.15, `#0C0C0E` |
| Subtitle | One UI Sans | 300 | 42 | ls −1%, `#B4B4BB` |
| Input / placeholder | One UI Sans | 400 | 28 | |
| Counter number "50" | Samsung Sharp Sans | 500 (Medium) | 52 | ls −1% |
| Counter "/100" | Samsung Sharp Sans | 400 | 24 | `#9A9AA1` |
| Counter label "자리 남음" | One UI Sans | 400 | 32 | `#B4B4BB`, 12 left gap |

Counter row: all items **vertically centered** on one line, 10 gap.
Font loading: `font-display: block` + full-page preload → no fallback flash.

## 4. Components

### Email pill
- 600 × 79, radius fully rounded, 1px `border/input`, white fill
- Shadow: `0 6 24 rgba(20,20,40,.06)` (focus: `0 8 28 rgba(20,20,40,.10)`)
- Text inset: 36 left, 96 right
- Placeholder: `이메일을 남겨주세요`

### Submit button (inside pill, right)
- 56 Ø circle, 12 from right edge, vertically centered
- Icon: 25 box, white stroke 2.4, round caps — arrow (idle) / check (success)
- Hover: +5% brightness · Press: scale 0.94

## 5. States & motion

| State | Trigger | Spec |
|---|---|---|
| Idle | — | Silver button |
| Filled | field has text | Button cross-fades to black, 250ms ease |
| Focus | input focus | Border + shadow deepen, 200ms |
| Error | invalid email submitted | Pill shakes ±15, 550ms `cubic-bezier(.36,.07,.19,.97)`; border/text/button turn orange. **No error text.** Clears on next keystroke |
| Success | valid submit | Button pops (scale 1 → 1.35 → 1, 450ms overshoot), turns green with check; input locks; counter −1; particle burst (below); then the welcome sequence (below) |
| Page load | assets ready | Page starts white; bg + content fade in 800ms ease. 5s safety timeout |

### Success welcome sequence (after the burst)

Timeline from the moment of a valid submit:

| t | What happens |
|---|---|
| 0 | Green check + particle burst (form still visible) |
| +800ms | Form + counter fade **out** (400ms); welcome message fades **in** (450ms, rises 12) |
| hold | Welcome shows for ~2s |
| +2450ms | Welcome fades **out** completely (450ms) — nothing else visible yet |
| +550ms later | Form + counter fade **back in**, fully reset: empty field, silver button, editable. Counter keeps decremented value |

Welcome message: `베타에 오신 걸 환영해요` — One UI Sans 600, 48,
ls −2%, `state/success` green `#4B8F5F`. Positioned in the pill's exact
vertical band (top 56, height 79), horizontally centered — it replaces the
pill optically. No emoji in the string (keeps optical centering; the
confetti provides the celebration).

### Success particle burst
- Origin: button center. 3 waves: 28 @ 0ms (power 1.0), 16 @ 400ms (0.7), 12 @ 850ms (0.55)
- Mix: 40% emoji 🎉 ✨ 🎊 ⭐ 💜 (34–62), 60% dots 9–19 Ø
  (`#8B7CF6 #B7A9FF #FFD166 #FF8FA3 #7BD7A8 #7CC7F6`)
- Physics (per 60fps frame): launch 2.4–6.4 px, upward fan ±135°; gravity 0.05;
  x-damping 0.992; spin ±3.5°; life 190–280 frames (~3–4.5s); fade out over the last 35%
- `prefers-reduced-motion`: skip the burst; the welcome sequence still runs
  (plain fades)

## 6. Assets

| Asset | Spec |
|---|---|
| `assets/logo.svg` | Vector, black + 20% black dot |
| `assets/bg-phone.png` | 3840×1040 @2x (bottom 1040 design px of the mockup) |
| `assets/og-thumbnail.jpg` | 1200×630 link preview (Frame 24, top crop) |
| Fonts | One UI Sans 300/400/600/700 · Samsung Sharp Sans 400/500/700 (TTF) |

## 7. Copy (ko)

- Heading: `신뢰하는 사람들에게 물어보세요`
- Subtitle: `지금 등록하면 토큰 무제한 이용`
- Placeholder: `이메일을 남겨주세요`
- Counter: `{remaining} /100 자리 남음` (remaining = 100 − signups; demo: 50)
- Success welcome: `베타에 오신 걸 환영해요`
