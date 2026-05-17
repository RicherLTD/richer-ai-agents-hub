import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans:    ["Heebo", "Geist", "-apple-system", "BlinkMacSystemFont", "system-ui", "sans-serif"],
        latin:   ["Geist", "Heebo", "-apple-system", "system-ui", "sans-serif"],
        display: ["Instrument Serif", "Heebo", "serif"],
        mono:    ["Geist Mono", "JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          deep: "hsl(var(--primary-deep))",
          light: "hsl(var(--primary-light))",
          soft: "hsl(var(--primary-soft))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
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
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius-lg)",          /* 8px — modals */
        md: "var(--radius)",              /* 6px — cards, default buttons */
        sm: "var(--radius-sm)",           /* 4px — inputs, chips */
      },
      fontSize: {
        "2xs":  ["11px", { lineHeight: "14px" }],
        xs:     ["12px", { lineHeight: "16px" }],
        sm:     ["13px", { lineHeight: "18px" }],
        base:   ["14px", { lineHeight: "20px" }],
        md:     ["16px", { lineHeight: "24px" }],
        lg:     ["20px", { lineHeight: "28px" }],
        xl:     ["24px", { lineHeight: "32px" }],
        "2xl":  ["32px", { lineHeight: "40px" }],
        "3xl":  ["40px", { lineHeight: "48px" }],
      },
      transitionTimingFunction: {
        "out-quint": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      boxShadow: {
        popover: "var(--shadow-popover)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;

// Note: Heebo font loaded via index.html link tag.

