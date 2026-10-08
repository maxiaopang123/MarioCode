/**
 * 画布工作台的共享小件:按 id 懒加载图片 data URL、时间格式化、范围类型。
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";

/** 画布图库范围:独立图库,或某个项目的项目图库。 */
export interface CanvasScopeSel {
  scope: "global" | "project";
  projectId: string | null;
}

/**
 * 按图片 id 懒加载 data URL(id 变重取;失败只标记不抛)。画廊卡片与派生链
 * 缩略图共用——图片内容经 canvas.imageData 按张取,不随列表一次性搬运。
 */
export function useCanvasImageUrl(id: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; url: string | null; failed: boolean }>({
    id: null,
    url: null,
    failed: false,
  });
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void api.canvas.imageData({ id }).then((res) => {
      if (!alive) return;
      setState(res.ok && res.dataUrl ? { id, url: res.dataUrl, failed: false } : { id, url: null, failed: true });
    });
    return () => {
      alive = false;
    };
  }, [id]);
  // id 换了而加载未回:不展示旧图(返回 null 占位)。
  if (!id || state.id !== id) return { url: null, failed: false };
  return { url: state.url, failed: state.failed };
}

/** MM-DD HH:mm(图库卡片与派生链节点的时间标注)。 */
export function formatCanvasTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
