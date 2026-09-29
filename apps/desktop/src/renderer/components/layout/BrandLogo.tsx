import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
// 两张图都由 build/gen_icon.py 生成,与应用图标同一套几何 M:
// brand-logo.png = 深色底(与安装包 / 任务栏图标 build/icon.png 相同),
// brand-logo-light.png = 浅色底(浅色主题下与界面融为一体)。
import brandLogoDarkUrl from "@renderer/brand-logo.png";
import brandLogoLightUrl from "@renderer/brand-logo-light.png";

interface BrandLogoProps {
  /** Logo 边长(px)。默认 28。 */
  size?: number;
  className?: string;
}

/** Tracks `<html class="dark">` (the renderer's single source of the
 *  effective theme) without re-subscribing to theme IPC per logo instance. */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setDark(el.classList.contains("dark")));
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** MarioCode 品牌 logo:深色主题用深色底版本,浅色主题用浅色底版本。
 *  图片自带圆角与透明外缘,不再额外裁切或描边。 */
export function BrandLogo({ size = 28, className }: BrandLogoProps) {
  const dark = useIsDarkTheme();
  return (
    <img
      src={dark ? brandLogoDarkUrl : brandLogoLightUrl}
      alt=""
      aria-hidden
      width={size}
      height={size}
      // draggable={false} 避免用户意外拖拽图片;decoding="async" 不阻塞渲染。
      draggable={false}
      decoding="async"
      className={cn("shrink-0 select-none object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}
