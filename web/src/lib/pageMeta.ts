import { useEffect } from 'react';

// PER-ROUTE TITLE AND DESCRIPTION.
//
// A single-page app keeps whatever <title> index.html shipped with unless
// something changes it, so every route here read "PUNKLABZ TERMINAL" — in the
// tab, in bookmarks, in browser history, and in the back-button menu. That is
// a navigation problem before it is ever an SEO one: a user with four tabs
// open could not tell them apart.
//
// The description matters for a different reason. Most routes sit behind a
// login and no crawler will ever see them, but the meta and OG tags are also
// what renders when someone pastes a link into a chat — which is the actual
// way this site gets shared.

const SUFFIX = 'PunkLabz Terminal';

function upsertMeta(selector: string, attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/**
 * Set the document title and description for a route.
 *
 * `name` is the page's own name; the product name is appended. Pass an empty
 * name for the landing page, which should read as the product itself rather
 * than as " · PunkLabz Terminal" hanging off nothing.
 */
export function usePageMeta(name: string, description?: string): void {
  useEffect(() => {
    document.title = name ? `${name} · ${SUFFIX}` : SUFFIX;
    if (description) {
      upsertMeta('meta[name="description"]', 'name', 'description', description);
      // og:title/description are what a pasted link unfurls as; leaving them
      // at the static index.html values would describe the wrong page
      upsertMeta('meta[property="og:title"]', 'property', 'og:title', document.title);
      upsertMeta('meta[property="og:description"]', 'property', 'og:description', description);
    }
  }, [name, description]);
}
