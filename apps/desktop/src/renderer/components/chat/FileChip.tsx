/**
 * File-path chip inside a model reply (TODO-022, v3 prototype `.fchip`).
 *
 * The model names files constantly — `main/tools/imageGenerate.ts:142`,
 * `D:\MarioOutputs\sess\turn-3\`. When an inline-code span is exactly such a
 * path (see `classifyInlinePath`), it renders as a chip instead of plain code:
 *
 *  - single click  → SELECT: the chip highlights and its text becomes the DOM
 *                    selection, so Ctrl/⌘+C copies the path. Selecting must not
 *                    open anything — people click paths to copy them.
 *  - double click / Enter → OPEN in the editor (a folder is revealed in the OS
 *                    file manager); a short squeeze animation confirms it.
 *  - hover ~400ms  → a card with the resolved location, a thumbnail for
 *                    images, and 打开 / 在文件夹中显示 / 复制路径.
 *
 * Resolution (relative → absolute, ambiguity → candidate list) is the same
 * `resolveFilePathToken` the older FileLink uses, run lazily on first hover or
 * open — rendering stays synchronous and IPC-free, so streaming is unaffected.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { FileTypeIcon } from "@renderer/lib/fileIcon.js";
import {
  isImagePath,
  resolveFilePathToken,
  type InlinePathToken,
  type ResolvedCandidate,
} from "@renderer/lib/fileLink.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconCopy, IconFolder, IconFolderOpen, IconLoader2, IconPhoto } from "@renderer/lib/icons.js";
import { basename } from "@renderer/lib/path.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { loadMarkdownImageDataUrl } from "./MarkdownImage.js";

const HOVER_OPEN_MS = 400;
const HOVER_CLOSE_MS = 160;
const CARD_WIDTH = 360;

type Resolution =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; candidates: ResolvedCandidate[] };

export function FileChip({
  token,
  projectPath,
}: {
  token: InlinePathToken;
  /** Project root that relative tokens resolve against. */
  projectPath: string | null;
}) {
  const { t } = useI18n();
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [selected, setSelected] = useState(false);
  const [opening, setOpening] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [res, setRes] = useState<Resolution>({ state: "idle" });
  const [thumb, setThumb] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const resolving = useRef<Promise<ResolvedCandidate[]> | null>(null);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const folder = token.kind === "folder";
  const image = !folder && isImagePath(token.path);

  /** Resolve once; later calls share the same promise. */
  const resolve = useCallback((): Promise<ResolvedCandidate[]> => {
    if (!resolving.current) {
      setRes({ state: "loading" });
      resolving.current = resolveFilePathToken(token.path, projectPath)
        .catch(() => [] as ResolvedCandidate[])
        .then((candidates) => {
          setRes({ state: "done", candidates });
          return candidates;
        });
    }
    return resolving.current;
  }, [token.path, projectPath]);

  // Thumbnail for an image path once it resolves to exactly one file.
  useEffect(() => {
    if (!image || !cardOpen || res.state !== "done" || res.candidates.length !== 1) return;
    let cancelled = false;
    void loadMarkdownImageDataUrl(res.candidates[0].path).then((url) => {
      if (!cancelled) setThumb(url || null);
    });
    return () => {
      cancelled = true;
    };
  }, [image, cardOpen, res]);

  /* ── selection ─────────────────────────────────────────────────────── */

  // A selected chip deselects on the next pointerdown anywhere else.
  useEffect(() => {
    if (!selected) return;
    const onDown = (e: PointerEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      setSelected(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [selected]);

  const selectText = () => {
    const el = labelRef.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  /* ── open ──────────────────────────────────────────────────────────── */

  const openPath = (absPath: string) => {
    const store = useSessionStore.getState();
    if (folder) {
      void api.shell.showItemInFolder({ path: absPath }).catch(() => undefined);
      return;
    }
    if (isElectron) {
      store.openFileInIde(absPath, token.line ? { line: token.line, column: token.column } : undefined);
    } else {
      store.openMobileViewer({ kind: "file", name: basename(absPath), path: absPath });
    }
  };

  const open = async () => {
    setOpening(true);
    window.setTimeout(() => setOpening(false), 420);
    const candidates = await resolve();
    if (candidates.length === 1) {
      openPath(candidates[0].path);
      setCardOpen(false);
    } else {
      // 0 or many: the card is where the user sees why / picks one.
      showCard();
    }
  };

  /* ── hover card ────────────────────────────────────────────────────── */

  const showCard = () => {
    window.clearTimeout(closeTimer.current);
    const el = chipRef.current;
    if (el) setAnchor(el.getBoundingClientRect());
    setCardOpen(true);
    void resolve();
  };

  const onEnter = () => {
    window.clearTimeout(closeTimer.current);
    if (cardOpen) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(showCard, HOVER_OPEN_MS);
  };
  const onLeave = () => {
    window.clearTimeout(openTimer.current);
    closeTimer.current = window.setTimeout(() => setCardOpen(false), HOVER_CLOSE_MS);
  };

  // Scrolling the transcript moves the chip away from a fixed-position card.
  useEffect(() => {
    if (!cardOpen) return;
    const close = () => setCardOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [cardOpen]);

  const copyPath = (p: string) => {
    void navigator.clipboard.writeText(p).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  /* ── render ────────────────────────────────────────────────────────── */

  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(true);
    selectText();
  };
  const handleDouble = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selectText();
    void open();
  };
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void open();
    } else if (e.key === " ") {
      e.preventDefault();
      setSelected(true);
      selectText();
    }
  };

  const icon = folder ? (
    <IconFolder size={13} className="fchip-ic" />
  ) : image ? (
    <IconPhoto size={13} className="fchip-ic" />
  ) : (
    <FileTypeIcon path={token.path} size={13} className="fchip-ic" />
  );

  const single = res.state === "done" && res.candidates.length === 1 ? res.candidates[0] : null;
  const shownPath = single?.path ?? token.path;
  const kindLabel = folder
    ? t("chatStream.fileChip.folder")
    : image
      ? t("chatStream.fileChip.image")
      : t("chatStream.fileChip.file");

  const card =
    cardOpen && anchor
      ? createPortal(
          <div
            role="dialog"
            className="fpop"
            style={{
              top: Math.min(anchor.bottom + 6, window.innerHeight - 160),
              left: Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8)),
              width: CARD_WIDTH,
            }}
            onPointerEnter={() => window.clearTimeout(closeTimer.current)}
            onPointerLeave={onLeave}
          >
            {image && (
              <span className="fpop-thumb">
                {thumb ? (
                  <img src={thumb} alt="" draggable={false} />
                ) : (
                  <IconPhoto size={18} className="text-content-subtle" />
                )}
              </span>
            )}
            <span className="fpop-body">
              <b className="fpop-title">
                <span className="truncate">{basename(shownPath.replace(/[\\/]+$/, "")) || shownPath}</span>
                {token.line ? (
                  <span className="fpop-meta">{t("chatStream.fileChip.line", { n: token.line })}</span>
                ) : null}
                <span className="fpop-hint">{t("chatStream.fileChip.hint")}</span>
              </b>
              <span className="fpop-path" title={shownPath}>
                {kindLabel} · {single?.relativePath ?? token.path}
              </span>
              {res.state === "loading" || res.state === "idle" ? (
                <span className="fpop-path">
                  <IconLoader2 size={11} className="mr-1 inline animate-spin" />
                </span>
              ) : res.candidates.length === 0 ? (
                <span className="fpop-path">{t("chatStream.fileLink.noMatch")}</span>
              ) : res.candidates.length > 1 ? (
                <span className="fpop-list">
                  <span className="fpop-path">{t("chatStream.fileLink.matchCount", { n: res.candidates.length })}</span>
                  {res.candidates.slice(0, 6).map((c) => (
                    <button key={c.path} type="button" className="fpop-cand" onClick={() => openPath(c.path)}>
                      <FileTypeIcon path={c.path} size={12} className="shrink-0" />
                      <span className="truncate">{c.relativePath}</span>
                    </button>
                  ))}
                </span>
              ) : null}
              <span className="fpop-acts">
                {single && (
                  <button type="button" className="fpop-btn fpop-btn-primary" onClick={() => openPath(single.path)}>
                    {folder ? <IconFolderOpen size={13} /> : <FileTypeIcon path={single.path} size={13} />}
                    {folder ? t("chatStream.fileChip.reveal") : t("chatStream.fileChip.open")}
                  </button>
                )}
                {single && !folder && isElectron && (
                  <button
                    type="button"
                    className="fpop-btn"
                    onClick={() => void api.shell.showItemInFolder({ path: single.path }).catch(() => undefined)}
                  >
                    <IconFolderOpen size={13} />
                    {t("chatStream.fileChip.reveal")}
                  </button>
                )}
                <button type="button" className="fpop-btn" onClick={() => copyPath(shownPath)}>
                  {copied ? <IconCheck size={13} className="text-success" /> : <IconCopy size={13} />}
                  {copied ? t("chatStream.fileChip.copied") : t("chatStream.fileChip.copyPath")}
                </button>
              </span>
            </span>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <span
        ref={chipRef}
        role="button"
        tabIndex={0}
        title={t("chatStream.fileChip.hint")}
        className={cn("fchip", selected && "fchip-sel", opening && "fchip-opening", cardOpen && "fchip-on")}
        onClick={handleClick}
        onDoubleClick={handleDouble}
        onKeyDown={handleKey}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
      >
        {icon}
        <span ref={labelRef} className="fchip-label">
          {token.path}
          {token.line ? <em>:{token.line}{token.column ? `:${token.column}` : ""}</em> : null}
        </span>
      </span>
      {card}
    </>
  );
}
