import { useCallback, useMemo, useState, type PointerEvent, type ThHTMLAttributes } from "react";
import type { ColumnsType, ColumnType } from "antd/es/table";

const MIN_WIDTH = 60;

type HeaderCellProps = ThHTMLAttributes<HTMLTableCellElement> & {
  onResizeStart?: (e: PointerEvent<HTMLSpanElement>) => void;
};

/** Table header cell with a drag handle on its right edge. */
function ResizableHeaderCell({ onResizeStart, children, style, ...rest }: HeaderCellProps) {
  if (!onResizeStart) return <th {...rest} style={style}>{children}</th>;
  return (
    <th {...rest} style={{ ...style, position: "relative" }}>
      {children}
      <span className="col-resizer" onPointerDown={onResizeStart} onClick={(e) => e.stopPropagation()} />
    </th>
  );
}

export const resizableComponents = { header: { cell: ResizableHeaderCell } };

function load(key: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function save(key: string, widths: Record<string, number>) {
  try {
    localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    // Widths are a convenience; without storage they last until reload.
  }
}

/**
 * Makes columns resizable by dragging the header edge. Every column needs a
 * `key` and a default `width`; user widths are kept per table in the browser.
 */
export function useColumnWidths<T>(tableId: string, columns: ColumnsType<T>) {
  const storageKey = `column-widths:${tableId}`;
  const [widths, setWidths] = useState<Record<string, number>>(() => load(storageKey));

  const startResize = useCallback(
    (key: string, startWidth: number) => (e: PointerEvent<HTMLSpanElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const handle = e.currentTarget;
      handle.classList.add("active");
      document.body.classList.add("col-resizing");
      let latest = startWidth;
      const move = (ev: globalThis.PointerEvent) => {
        latest = Math.max(MIN_WIDTH, Math.round(startWidth + ev.clientX - startX));
        setWidths((w) => ({ ...w, [key]: latest }));
      };
      const up = () => {
        handle.classList.remove("active");
        document.body.classList.remove("col-resizing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setWidths((w) => {
          const next = { ...w, [key]: latest };
          save(storageKey, next);
          return next;
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [storageKey],
  );

  const sized = useMemo(
    () =>
      columns.map((c) => {
        const col = c as ColumnType<T>;
        const key = String(col.key);
        const width = widths[key] ?? (col.width as number);
        return {
          ...col,
          width,
          onHeaderCell: () => ({ onResizeStart: startResize(key, width) }) as HeaderCellProps,
        };
      }),
    [columns, widths, startResize],
  );

  const totalWidth = sized.reduce((sum, c) => sum + (c.width ?? 0), 0);

  const reset = useCallback(() => {
    setWidths({});
    save(storageKey, {});
  }, [storageKey]);

  return { columns: sized, totalWidth, reset };
}
