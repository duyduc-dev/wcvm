# wcvm landing page

The static page served at **https://wcvmjs.com**: a Vite project with no framework and no runtime dependencies: plain HTML and CSS, plus one small script
(the typing terminal, scroll reveals, the glow that follows the pointer on cards, and the copy button).
Everything animated respects `prefers-reduced-motion`: the terminal is then drawn finished and nothing moves.

Sections, top to bottom: hero (typing terminal), framework marquee, animated stats, feature cards, a sticky four-step story that follows the
scroll, a bento grid of capabilities, a Studio mock that tilts into view, tabbed code samples, use cases, the animated architecture diagram, an
FAQ and the final call to action. Scroll effects (progress bar, parallax, count-up numbers, reveal, scroll-spy nav) live in `src/main.js`.

```bash
pnpm --filter wcvm-landing dev       # http://localhost:5192
pnpm --filter wcvm-landing build     # -> apps/landing/dist
```

`public/` holds the logo, the animated architecture diagram (`architecture-animated.svg`, CSS-animated, no script), the social preview image, `robots.txt`, `sitemap.xml` and a `_headers` file. Deploy
settings are in [`DEPLOYING.md`](../../DEPLOYING.md).

## Logos

`public/logos/*.svg` are the framework logos in the strip and the Studio chips. They come from [simple-icons](https://simpleicons.org)
(CC0): the path data is unchanged, each file is filled with the brand colour, and a colour too dark for the page is lightened. The marks
are trademarks of their owners and are shown only to say that these projects run on wcvm.
