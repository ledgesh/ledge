import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Standard shadcn/ui Button. Added by hand rather than via the shadcn CLI because
// Electrobun's non-standard view layout confuses the CLI's framework detection.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        // The app's only use of `bg-destructive-fill`, and stock shadcn apart
        // from that token name. Elsewhere the colour is `text-destructive`
        // prose; this button paints a rectangle under near-white text, so it
        // needs the dark red. The names are not synonyms: dark mode writes in
        // red-400 and fills with red-900 (index.css).
        destructive:
          "bg-destructive-fill text-destructive-foreground shadow-sm hover:bg-destructive-fill/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // `touch:` is `@media (hover: none)`: every size is 44 points on a touch
      // client (interactions.md §1a). The size sits on the control, not the
      // call sites, the way MenuItem does. An `sm` button is 28 points tall and
      // every dialog's action pair is `sm` (Cancel beside Unlock, Change
      // Passphrase, Save), so a miss cancels the dialog and discards the field.
      size: {
        // Pixels, not `h-11`: the document's root is `font: 14px`, so a
        // rem-based utility silently means 38.5 (§1a, "write it in pixels").
        // A caller that passes its own size in `className` still wins,
        // because twMerge resolves in the caller's favour. The header's
        // buttons pass `size-7` and get it (App.tsx).
        default: "h-9 px-4 py-2 touch:h-[44px]",
        sm: "h-8 rounded-md px-3 text-xs touch:h-[44px] touch:px-4",
        lg: "h-10 rounded-md px-8 touch:h-[44px]",
        icon: "h-9 w-9 touch:size-[44px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
