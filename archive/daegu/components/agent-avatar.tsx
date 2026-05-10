export function AgentAvatar({
  name,
  isHuman,
  isOrchestrator,
  size = 32,
}: {
  name: string;
  isHuman?: boolean;
  isOrchestrator?: boolean;
  size?: number;
}) {
  const initial = (name?.trim()[0] ?? "?").toUpperCase();
  const ring = isOrchestrator
    ? "ring-2 ring-orange-500"
    : isHuman
      ? "ring-1 ring-emerald-600"
      : "ring-1 ring-zinc-700";
  const bg = isHuman ? "bg-emerald-900/40" : "bg-zinc-800";
  const fg = isHuman ? "text-emerald-200" : "text-zinc-200";
  return (
    <div
      className={`inline-flex items-center justify-center rounded-full ${bg} ${fg} ${ring} font-mono`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={name}
    >
      {initial}
    </div>
  );
}
