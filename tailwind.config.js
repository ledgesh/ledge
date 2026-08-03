import plugin from "tailwindcss/plugin";

/** @type {import('tailwindcss').Config} */
export default {
  // `dark:` keys off the same `data-theme` attribute the whole palette does
  // (index.css, stamped by lib/theme.ts): the OS appearance is the default,
  // but `appearance.theme` in settings can pin the other side, so asking
  // prefers-color-scheme directly would disagree with everything else.
  darkMode: ["selector", '[data-theme="dark"]'],
  future: {
    // Every `hover:` and `group-hover:` inside `@media (hover: hover)`, which
    // is a correctness fix on touch and a no-op everywhere else
    // (interactions.md §1a: a touch client has no hover).
    //
    // Not cosmetic. iOS sends a synthetic mousemove ahead of the click of
    // every tap, and WebKit's ContentChangeObserver WITHHOLDS that click when
    // the mousemove changed the rendering — the tap is spent painting the
    // hover, and it takes a second one to act. A tab strip whose close button
    // fades in on `group-hover` is exactly that change, so switching notes on
    // a phone cost two taps. Gating the variant is what makes the first tap
    // land, on every hover style in the app at once rather than at the sites
    // someone remembered.
    hoverOnlyWhenSupported: true,
  },
  content: ["./src/mainview/**/*.{html,js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    plugin(({ addVariant }) => {
      // `hoverable:` is presence rather than appearance, and it is the other
      // half of `hoverOnlyWhenSupported` above: that flag stops a hover style
      // from applying on touch, but a control whose RESTING state is invisible
      // (`opacity-0`, revealed by `group-hover`) would then never be seen and
      // still take every tap that landed on it. `hidden hoverable:flex` makes
      // it absent instead — which is what §1a already says a phone gets, the
      // row's own menu carrying the verb — while leaving the desktop reveal
      // exactly as it was, space reserved and all, so nothing reflows on hover.
      addVariant("hoverable", "@media (hover: hover)");
      // `touch:` is the exact complement, for the rules that are about the SIZE
      // of what points rather than about a hover style: a mouse is a pixel and a
      // finger is a pad, so a control sized for one is a mis-tap on the other.
      // The same media feature both ways deliberately — a client either hovers
      // or it does not, and two different discriminators would eventually
      // disagree about the same device (lib/viewport.ts says why width answers
      // the layout question and nothing else).
      addVariant("touch", "@media (hover: none)");
    }),
  ],
};
