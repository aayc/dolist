import { LinkPopover, type LinkPreview, webLinkPreview } from "@ddl/editor";
import { type RefObject, useEffect, useRef } from "react";
import { useServices } from "../../app/services";
import { useAgentStore } from "../../state/agent-store";
import { findSource } from "../links/link-previews";

const HOVER_MS = 300;
const WEB_LINK = /^(?:https?|mailto|tel):/i;

function linkIn(root: HTMLElement, target: EventTarget | null): HTMLAnchorElement | null {
  const link = target instanceof Element ? target.closest("a[href]") : null;
  return link instanceof HTMLAnchorElement && root.contains(link) && link.closest(".markdown")
    ? link
    : null;
}

/**
 * Links in rendered agent markdown: hovering (or focusing) one shows the same preview card as the
 * editor, from the thread's cited sources for web links and from the note for `[[wikilinks]]`,
 * which open in the editor when clicked (after `beforeOpenNote`).
 */
export function useMarkdownLinks(
  ref: RefObject<HTMLElement | null>,
  threadId: string,
  beforeOpenNote?: () => void,
): void {
  const { workspace } = useServices();
  const beforeOpen = useRef(beforeOpenNote);
  beforeOpen.current = beforeOpenNote;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const popover = new LinkPopover(document);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLAnchorElement | null = null;

    const previewOf = (link: HTMLAnchorElement): LinkPreview | Promise<LinkPreview> | null => {
      const note = link.dataset.wikilink;
      if (note !== undefined) return workspace.previews.note(note);
      const href = link.getAttribute("href") ?? "";
      if (!WEB_LINK.test(href)) return null;
      const sources = useAgentStore.getState().details[threadId]?.sources ?? [];
      return webLinkPreview(href, link.textContent ?? "", findSource(sources, href));
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      popover.hide();
    };
    const show = (link: HTMLAnchorElement, delay: number) => {
      if (link === current) return;
      hide();
      current = link;
      timer = setTimeout(async () => {
        const preview = await previewOf(link);
        if (current === link && preview && link.isConnected) {
          popover.show(preview, link.getBoundingClientRect());
        }
      }, delay);
    };

    const onOver = (event: MouseEvent) => {
      const link = linkIn(root, event.target);
      if (link) show(link, HOVER_MS);
    };
    const onOut = (event: MouseEvent) => {
      if (!current || linkIn(root, event.target) !== current) return;
      if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const link = linkIn(root, event.target);
      if (link) show(link, 0);
    };
    const onClick = (event: MouseEvent) => {
      const note = linkIn(root, event.target)?.dataset.wikilink;
      if (note === undefined || (event.type === "auxclick" && event.button !== 1)) return;
      event.preventDefault();
      hide();
      beforeOpen.current?.();
      void workspace.openWikiLink(note, event.metaKey || event.ctrlKey || event.button === 1);
    };

    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", hide);
    root.addEventListener("click", onClick);
    root.addEventListener("auxclick", onClick);
    root.addEventListener("scroll", hide, { passive: true });
    return () => {
      hide();
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("click", onClick);
      root.removeEventListener("auxclick", onClick);
      root.removeEventListener("scroll", hide);
    };
  }, [ref, threadId, workspace]);
}
