/**
 * Images inside a model reply (TODO-022).
 *
 * The model frequently answers with `![alt](D:/out/hero.png)` after generating
 * or editing a picture. Before this module such a reference degraded to a file
 * chip: the user had to click through to the editor to see what was produced.
 * Now the bytes are read through the existing `file.readBinary` guard (the
 * renderer cannot fetch drive-letter / relative URLs itself, and we do NOT
 * loosen the CSP to let it try) and rendered in place.
 *
 * Three shapes, mirroring `prototypes/ui-refresh-v3.html`:
 *  - single image  → a figure with a bottom info bar (name · dimensions · size)
 *                    and four actions (open in editor / reveal / copy / attach
 *                    to the next turn);
 *  - 2+ consecutive images in one paragraph → an equal-width grid of square
 *                    tiles with a hover caption; clicking any tile opens the
 *                    shared lightbox with ←/→ stepping across the whole group
 *                    (see {@link MarkdownGallery});
 *  - a remote `http(s)` image → NOT auto-loaded. It renders as a placeholder
 *                    with a 「加载图片」 button that fetches through the main
 *                    process, so simply reading a reply never phones home and
 *                    the CSP stays `img-src 'self' data:`.
 *
 * Loading and missing states are explicit cards rather than layout jumps: a
 * broken path in a three-image grid keeps its cell, so the user can see WHICH
 * one failed.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { shouldAutoLoadImage } from "@renderer/lib/chatDisplay.js";
import { useReplyImages } from "./ReplyImageContext.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { basename } from "@renderer/lib/path.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ImageWithPreview } from "@renderer/components/ui/image-preview.js";
import {
  IconCheck,
  IconCopy,
  IconFile,
  IconFolderOpen,
  IconLoader2,
  IconMessage,
  IconPhoto,
  IconPhotoOff,
  IconWorld,
} from "@renderer/lib/icons.js";

/** Extensions we are willing to inline. Deliberately narrow: only formats a
 *  Chromium `<img>` renders from a data URL. `.svg` is included — the bytes
 *  arrive as a data URL inside an `<img>`, which is a passive context (no
 *  script execution), so a hostile SVG cannot reach the renderer. */
const INLINE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/** True when a path/URL looks like an image we can display inline. */
export function isInlineImagePath(p: string): boolean {
  // Strip a query/hash before testing so `hero.png?v=2` still matches.
  const clean = p.split(/[?#]/, 1)[0] ?? p;
  return INLINE_IMAGE_EXT.test(clean);
}

/* ── byte cache ───────────────────────────────────────────────────────── */

/** data-URL cache for local images referenced by markdown. Promise-valued so
 *  concurrent renders of the same path share one IPC read; failures are cached
 *  too (as "") so a re-render doesn't spam the backend. FIFO-capped so a long
 *  session can't grow it unboundedly. Cached bytes may go stale if the file is
 *  rewritten in place — acceptable for a transcript (the reply describes the
 *  image as it was produced); a reload re-reads. */
const mdImageDataUrls = new Map<string, Promise<string>>();
const MD_IMAGE_CACHE_CAP = 60;

export function loadMarkdownImageDataUrl(filePath: string): Promise<string> {
  const cached = mdImageDataUrls.get(filePath);
  if (cached) return cached;
  const promise = api.file
    .readBinary({ filePath })
    .then(({ dataUrl }) => dataUrl)
    .catch(() => "");
  mdImageDataUrls.set(filePath, promise);
  if (mdImageDataUrls.size > MD_IMAGE_CACHE_CAP) {
    const oldest = mdImageDataUrls.keys().next().value;
    if (oldest !== undefined) mdImageDataUrls.delete(oldest);
  }
  return promise;
}

/** Rough byte size of a `data:` URL payload (base64 is 4 chars per 3 bytes).
 *  Used for the figure's info bar — we never stat the file, so this is an
 *  estimate of the DECODED size, which is what the user cares about. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const b64 = dataUrl.length - comma - 1;
  return Math.max(0, Math.round((b64 * 3) / 4));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── gallery grouping ─────────────────────────────────────────────────── */

interface GalleryEntry {
  path: string;
  /** Loaded data URL, or "" when the read failed. */
  url: string;
}

interface GalleryCtx {
  entries: ReadonlyArray<GalleryEntry>;
  /** Report a loaded (or failed) sibling. Stable identity. */
  report: (path: string, url: string) => void;
}

const MarkdownGalleryContext = createContext<GalleryCtx | null>(null);

/**
 * Provider for a run of 2+ images that the `rehypeImageGallery` plugin pulled
 * out of one paragraph. Children register themselves as they finish loading
 * (mount order = DOM order for siblings), which is what lets a click on tile 2
 * open the lightbox at position 2 of 3 with ←/→ across the group — without
 * this component needing to resolve or fetch anything itself.
 */
export function MarkdownGallery({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<GalleryEntry[]>([]);
  const report = useCallback((path: string, url: string) => {
    setEntries((prev) => {
      const at = prev.findIndex((e) => e.path === path);
      if (at >= 0) {
        if (prev[at].url === url) return prev; // idempotent
        const next = prev.slice();
        next[at] = { path, url };
        return next;
      }
      return [...prev, { path, url }];
    });
  }, []);
  // The context value changes whenever a sibling finishes loading; that is the
  // point (tiles need the grown list to navigate), and the group is at most a
  // handful of nodes.
  return (
    <MarkdownGalleryContext.Provider value={{ entries, report }}>
      <div className="md-gallery">{children}</div>
    </MarkdownGalleryContext.Provider>
  );
}

/* ── shared state cards ───────────────────────────────────────────────── */

function StateCell({
  tile,
  icon,
  title,
  detail,
  action,
}: {
  tile: boolean;
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn("md-img-state", tile ? "md-img-state-tile" : "md-img-state-block")}>
      {icon}
      <span className="md-img-state-t">{title}</span>
      <span className="md-img-state-d" title={detail}>
        {detail}
      </span>
      {action}
    </div>
  );
}

/* ── single local image ───────────────────────────────────────────────── */

/** One action button in the figure's info bar. */
function BarAction({
  title,
  onClick,
  done,
  children,
}: {
  title: string;
  onClick: () => void;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
    >
      {done ? <IconCheck size={13} className="text-success" /> : children}
    </button>
  );
}

/**
 * A local image referenced from markdown. Renders inline once the bytes
 * arrive; falls back to an explicit "找不到文件" card (not a silent gap) when
 * the read is refused or the file is gone.
 *
 * `tile` is decided by the surrounding {@link MarkdownGallery}, not by the
 * caller: the same component is one big figure on its own and a square cell
 * inside a group.
 */
export function MarkdownLocalImage({
  filePath,
  alt,
}: {
  /** Absolute path, already resolved by the markdown `img` override. */
  filePath: string;
  alt: string;
}) {
  const { t } = useI18n();
  const gallery = useContext(MarkdownGalleryContext);
  const tile = gallery !== null;
  // null = still loading, "" = failed, otherwise a data: URL.
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const report = gallery?.report;
  const loadedPath = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadedPath.current = null;
    setDataUrl(null);
    setDims(null);
    void loadMarkdownImageDataUrl(filePath).then((url) => {
      if (cancelled) return;
      loadedPath.current = filePath;
      setDataUrl(url);
      report?.(filePath, url);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, report]);

  const replyImages = useReplyImages();
  const register = replyImages?.register;
  useEffect(() => {
    if (dataUrl && dims && loadedPath.current === filePath && register) return register(filePath);
  }, [dataUrl, dims, filePath, register]);

  const name = basename(filePath) || filePath;

  if (dataUrl === null) {
    return (
      <StateCell
        tile={tile}
        icon={<IconLoader2 size={tile ? 18 : 15} className="animate-spin text-content-subtle" />}
        title={t("chatStream.image.loading")}
        detail={name}
      />
    );
  }

  if (!dataUrl) {
    return (
      <StateCell
        tile={tile}
        icon={<IconPhotoOff size={tile ? 20 : 15} className="text-content-subtle" />}
        title={t("chatStream.image.missing")}
        detail={tile ? name : filePath}
        action={
          <button
            type="button"
            onClick={() => useSessionStore.getState().openFileInIde(filePath)}
            className="mt-0.5 rounded-md border border-edge px-2 py-0.5 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            {t("chatStream.image.openInEditor")}
          </button>
        }
      />
    );
  }

  /* ── tile inside a gallery ── */
  if (tile) {
    const loaded = gallery.entries.filter((e) => e.url);
    const srcs = loaded.map((e) => e.url);
    const idx = Math.max(
      0,
      loaded.findIndex((e) => e.path === filePath),
    );
    return (
      <ImageWithPreview
        src={dataUrl}
        alt={alt || name}
        gallery={srcs.length > 1 ? srcs : undefined}
        index={idx}
        triggerTitle={t("chatStream.image.zoom")}
        className="md-cell"
        thumb={
          <>
            <img src={dataUrl} alt={alt || name} draggable={false} className="md-cell-img"
              onLoad={e => { const el = e.currentTarget; if (el.naturalWidth) setDims({ w: el.naturalWidth, h: el.naturalHeight }); }}
              onError={() => setDataUrl("")} />
            <span className="md-cell-cap">{name}</span>
          </>
        }
      />
    );
  }

  /* ── standalone figure ── */
  const meta = [
    dims ? `${dims.w} × ${dims.h}` : null,
    fmtBytes(dataUrlBytes(dataUrl)),
  ]
    .filter(Boolean)
    .join(" · ");

  const flash = (set: (v: boolean) => void) => {
    set(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => set(false), 1400);
  };

  return (
    <figure className="md-figure">
      <ImageWithPreview
        src={dataUrl}
        alt={alt || name}
        triggerTitle={t("chatStream.image.zoom")}
        className="md-figure-pic"
        thumb={
          <img
            src={dataUrl}
            alt={alt || name}
            draggable={false}
            onError={() => setDataUrl("")}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth) setDims({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            className="md-figure-img"
          />
        }
      />
      <figcaption className="md-figure-bar">
        <IconPhoto size={13} className="shrink-0 text-content-subtle" />
        <span className="md-figure-nm" title={filePath}>
          {name}
        </span>
        {meta && <span className="md-figure-meta">{meta}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-px">
          <BarAction
            title={t("chatStream.image.openInEditor")}
            onClick={() => useSessionStore.getState().openFileInIde(filePath)}
          >
            <IconFile size={13} />
          </BarAction>
          {isElectron && (
            <BarAction
              title={t("chatStream.image.reveal")}
              done={revealed}
              onClick={() => {
                void api.shell.showItemInFolder({ path: filePath }).then(
                  () => flash(setRevealed),
                  () => undefined,
                );
              }}
            >
              <IconFolderOpen size={13} />
            </BarAction>
          )}
          <BarAction
            title={t("chatStream.image.copy")}
            done={copied}
            onClick={() => {
              void api.clipboardFile.writeImage({ dataUrl }).then((r) => {
                if (r.ok) flash(setCopied);
              });
            }}
          >
            <IconCopy size={13} />
          </BarAction>
          <BarAction
            title={t("chatStream.image.attach")}
            onClick={() => useSessionStore.getState().enqueueChatFile(filePath)}
          >
            <IconMessage size={13} />
          </BarAction>
        </span>
      </figcaption>
    </figure>
  );
}

/* ── remote image ─────────────────────────────────────────────────────── */

/**
 * A remote `http(s)` image. Manual by default: the placeholder shows the host
 * and a 「加载图片」 button, and the bytes are fetched by the MAIN process
 * (`net.fetchImage`) and handed back as a data URL. Two reasons it works this
 * way instead of just letting the `<img>` load:
 *  - reading a reply must not silently ping a third-party host (a model-quoted
 *    URL can be a tracker); automatic loading follows the saved preference;
 *  - the renderer's CSP stays `img-src 'self' data:` — no remote origin is
 *    ever allowed to load into the app.
 */
export function MarkdownRemoteImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useI18n();
  const gallery = useContext(MarkdownGalleryContext);
  const tile = gallery !== null;
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [dataUrl, setDataUrl] = useState<string>("");
  const [error, setError] = useState<string>("");

  const host = (() => {
    try {
      return new URL(src).host;
    } catch {
      return src;
    }
  })();

  const config = useSessionStore(s => s.chatDisplay);
  const automatic = shouldAutoLoadImage(src, config);
  const request = useRef(0);
  const load = useCallback(() => {
    const id = ++request.current;
    setState("loading");
    void api.net
      .fetchImage({ url: src })
      .then((res) => {
        if (id !== request.current) return;
        if (res.dataUrl) {
          setDataUrl(res.dataUrl);
          setState("idle");
        } else {
          setError(res.error ?? "");
          setState("error");
        }
      })
      .catch(() => { if (id === request.current) setState("error"); });
  }, [src]);
  useEffect(() => {
    setDataUrl(""); setError(""); setState("idle");
    return () => { request.current++; };
  }, [src]);
  useEffect(() => { if (automatic) load(); }, [automatic, load]);

  if (dataUrl) {
    return (
      <ImageWithPreview
        src={dataUrl}
        alt={alt || host}
        triggerTitle={t("chatStream.image.zoom")}
        className={tile ? "md-cell" : "md-figure-pic md-figure-lone"}
        thumb={
          <>
            <img src={dataUrl} alt={alt || host} draggable={false} className={tile ? "md-cell-img" : "md-figure-img"} />
            {tile && <span className="md-cell-cap">{host}</span>}
          </>
        }
      />
    );
  }

  return (
    <StateCell
      tile={tile}
      icon={
        state === "loading" ? (
          <IconLoader2 size={tile ? 18 : 15} className="animate-spin text-content-subtle" />
        ) : (
          <IconWorld size={tile ? 20 : 15} className="text-content-subtle" />
        )
      }
      title={state === "error" ? t("chatStream.image.loadFailed") : t("chatStream.image.remote")}
      detail={state === "error" && error ? error : host}
      action={
        state === "loading" ? undefined : (
          <button
            type="button"
            onClick={load}
            className="mt-0.5 rounded-md border border-edge px-2 py-0.5 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            {state === "error" ? t("chatStream.image.retry") : t("chatStream.image.loadRemote")}
          </button>
        )
      }
    />
  );
}
