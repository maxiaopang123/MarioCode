import { cn } from "@renderer/lib/cn.js";
// 由 build/gen_icon.py 生成,与安装包 / 任务栏图标 build/icon.png 是同一张图:
// 陶土橙圆底在浅色和深色主题下都清晰,不再区分深浅两版。
import brandLogoUrl from "@renderer/brand-logo.png";

interface BrandLogoProps {
  /** Logo 边长(px)。默认 28。 */
  size?: number;
  className?: string;
}

/** MarioCode 品牌 logo。图片自带圆形与透明外缘,不再额外裁切或描边。 */
export function BrandLogo({ size = 28, className }: BrandLogoProps) {
  return (
    <img
      src={brandLogoUrl}
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
