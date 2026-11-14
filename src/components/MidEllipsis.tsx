// Repository and folder names often differ only at the end
// ("pequod-app" vs "pequod-app-staging"), so when space runs out the
// middle is cut and the tail stays readable: "pequod…-staging".
import { splitPathTail, splitTail } from "../lib/format";

export function MidEllipsis({ text, className, path }: { text: string; className?: string; path?: boolean }) {
  const [head, tail] = path ? splitPathTail(text) : splitTail(text);
  return (
    <span className={"mid-ellipsis" + (className ? " " + className : "")}>
      <span className="me-head">{head}</span>
      {tail && <span className="me-tail">{tail}</span>}
    </span>
  );
}
