import type { MetadataRoute } from "next";

/**
 * Web app manifest (docs/pwa-architecture.md). Colours: the brand teal of
 * public/icon.svg and the light-mode background token (globals.css).
 * The start URL needs a session; signed-out launches go to sign-in, as on the web.
 */
export const THEME_COLOR = "#0f766e";
export const BACKGROUND_COLOR = "#f8f9fb";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "DealMind AI",
    short_name: "DealMind",
    description:
      "Compare prices across the Indian shopping sites DealMind is connected to, check whether a discount is genuine, and track prices.",
    lang: "en-IN",
    dir: "ltr",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "any",
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    categories: ["shopping", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      {
        name: "Search products",
        url: "/search",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Watchlists",
        url: "/watchlists",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Price alerts",
        url: "/alerts",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
