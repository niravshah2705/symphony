// Generative UI, v1: the harness's structured terminal result rendered as a
// widget instead of a JSON dump. The carrier is kagent's structured-output data
// part (go/api/a2a/structured_output.go), which the BFF reads and classifies into
// `{kind, props}`; this file is the registry of what the browser will draw.
//
// Two rules. The registry is closed: an unknown `kind` falls through to JSON, it
// is never guessed at, because a widget built on the wrong shape reads as a
// confident lie. And nothing here is HTML-injectable — every value is rendered as
// a text node or an attribute React escapes.

import type { FC } from 'react';
import type { DataMessagePartProps } from '@assistant-ui/react';

// Byte-identical to UI_CUSTOM_EVENT in packages/shared/src/agui.ts (the SPA spells
// the wire keys it matches on locally; see FleetAgUiAgent.ts).
export const UI_CUSTOM_EVENT = 'fleet.dev/ui';

const MAX_ROWS = 200;
const MAX_CELL = 400;

const cell = (value: unknown): string => {
  const text =
    typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? ''
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
};

interface Column {
  key: string;
  title: string;
}

const readColumns = (props: Record<string, unknown>, rows: Record<string, unknown>[]): Column[] => {
  const declared = Array.isArray(props.columns) ? props.columns : [];
  const columns = declared
    .filter((column): column is Record<string, unknown> => typeof column === 'object' && column !== null)
    .map((column) => ({
      key: typeof column.key === 'string' ? column.key : typeof column.field === 'string' ? column.field : cell(column.key ?? column.field),
      title: typeof column.title === 'string' ? column.title : typeof column.label === 'string' ? column.label : cell(column.key ?? column.title ?? column.field),
    }))
    .filter((column) => column.key !== '');
  if (columns.length > 0) return columns;
  const keys: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  return keys.map((key) => ({ key, title: key }));
};

const Table: FC<{ props: Record<string, unknown> }> = ({ props }) => {
  const rows = (Array.isArray(props.rows) ? props.rows : Array.isArray(props.items) ? props.items : [])
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .slice(0, MAX_ROWS);
  if (rows.length === 0) return null;
  const columns = readColumns(props, rows);
  if (columns.length === 0) return null;
  return (
    <div className="aui-gen aui-gen-table-wrap">
      {typeof props.title === 'string' ? <p className="aui-gen-title">{props.title}</p> : null}
      <table className="aui-gen-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>{cell(row[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {Array.isArray(props.rows) && (props.rows as unknown[]).length > MAX_ROWS ? (
        <p className="aui-gen-note">first {MAX_ROWS} of {(props.rows as unknown[]).length} rows</p>
      ) : null}
    </div>
  );
};

// Chart-lite: bars in CSS, because a chart library is a dependency this surface
// does not need to answer "which of these is biggest".
const Chart: FC<{ props: Record<string, unknown> }> = ({ props }) => {
  const labels = (Array.isArray(props.labels) ? props.labels : []).map(cell);
  const values = (Array.isArray(props.values) ? props.values : []).map((value) => (typeof value === 'number' ? value : Number(cell(value))));
  const points = labels
    .map((label, index) => ({ label, value: Number.isFinite(values[index]) ? (values[index] as number) : 0 }))
    .slice(0, MAX_ROWS);
  if (points.length === 0) return null;
  const scale = Math.max(...points.map((point) => Math.abs(point.value)), 1);
  return (
    <div className="aui-gen aui-gen-chart">
      {typeof props.title === 'string' ? <p className="aui-gen-title">{props.title}</p> : null}
      {points.map((point, index) => (
        <div key={`${point.label}-${index}`} className="aui-gen-bar-row">
          <span className="aui-gen-bar-label">{point.label}</span>
          <span className="aui-gen-bar-track">
            <span className="aui-gen-bar" style={{ width: `${Math.round((Math.abs(point.value) / scale) * 100)}%` }} />
          </span>
          <span className="aui-gen-bar-value">{point.value}</span>
        </div>
      ))}
    </div>
  );
};

// A before/after pair, not a computed line diff: the harness decided the change,
// and two blocks labelled − and + say that without pretending to be git.
const Diff: FC<{ props: Record<string, unknown> }> = ({ props }) => {
  const before = cell(props.before);
  const after = cell(props.after);
  if (before === '' && after === '') return null;
  return (
    <div className="aui-gen aui-gen-diff">
      {typeof props.path === 'string' ? <p className="aui-gen-title">{props.path}</p> : null}
      <pre className="aui-gen-diff-side aui-gen-diff-before">
        <span className="aui-gen-diff-mark">−</span>
        {before}
      </pre>
      <pre className="aui-gen-diff-side aui-gen-diff-after">
        <span className="aui-gen-diff-mark">+</span>
        {after}
      </pre>
    </div>
  );
};

const Json: FC<{ props: Record<string, unknown> }> = ({ props }) => {
  const value = 'value' in props ? props.value : props;
  return (
    <details className="aui-gen aui-gen-json" open={typeof value !== 'object' || value === null}>
      <summary>Structured result</summary>
      <pre>{JSON.stringify(value, null, 2)?.slice(0, 20000) ?? String(value)}</pre>
    </details>
  );
};

const REGISTRY: Record<string, FC<{ props: Record<string, unknown> }>> = {
  table: Table,
  chart: Chart,
  diff: Diff,
  json: Json,
};

const readSpec = (data: unknown): { kind: string; props: Record<string, unknown> } => {
  if (typeof data !== 'object' || data === null) return { kind: 'json', props: { value: data } };
  const spec = data as { kind?: unknown; props?: unknown };
  const kind = typeof spec.kind === 'string' ? spec.kind.toLowerCase() : 'json';
  const props = typeof spec.props === 'object' && spec.props !== null && !Array.isArray(spec.props) ? (spec.props as Record<string, unknown>) : { value: spec.props };
  return { kind, props };
};

export const GenerativeUI: FC<DataMessagePartProps> = ({ data }) => {
  const { kind, props } = readSpec(data);
  const Renderer = REGISTRY[kind] ?? Json;
  return <Renderer props={props} />;
};
