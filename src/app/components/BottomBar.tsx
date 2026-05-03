export function BottomBar() {
  return (
    <div className="h-full px-4 flex items-center justify-between text-[11px] text-text-tertiary">
      <div className="flex items-center gap-4">
        <span className="hover:text-text-secondary cursor-pointer transition-colors">
          127.0.0.1:3000
        </span>
        <span className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-success" />
          服务运行中
        </span>
      </div>
      
      <div className="flex items-center gap-4">
        <span>今日生成: 3</span>
        <span>v0.1.0</span>
      </div>
    </div>
  );
}
