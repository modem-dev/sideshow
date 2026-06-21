import { createSignal, For, Show } from "solid-js";
import type { JsonPart as JsonPartData } from "./api.ts";

export function JsonPart(props: { part: JsonPartData }) {
  return (
    <div class="jsonpart">
      <JsonNode value={props.part.data} depth={0} />
    </div>
  );
}

function JsonNode(props: { value: unknown; depth: number }) {
  const isContainer = () => typeof props.value === "object" && props.value !== null;

  return (
    <Show when={isContainer()} fallback={<Primitive value={props.value} />}>
      <Container value={props.value as object} depth={props.depth} />
    </Show>
  );
}

type Entry = readonly [string, unknown];

function Container(props: { value: object; depth: number }) {
  const [open, setOpen] = createSignal(props.depth === 0);
  const isArray = () => Array.isArray(props.value);
  const entries = (): Entry[] =>
    isArray()
      ? (props.value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(props.value as Record<string, unknown>);
  const count = () => entries().length;
  const openCh = () => (isArray() ? "[" : "{");
  const closeCh = () => (isArray() ? "]" : "}");
  const summary = () =>
    isArray()
      ? `${count()} item${count() === 1 ? "" : "s"}`
      : `${count()} key${count() === 1 ? "" : "s"}`;

  return (
    <Show
      when={count() > 0}
      fallback={
        <span class="json-empty">
          {openCh()}
          {closeCh()}
        </span>
      }
    >
      <span class="json-toggle" onClick={() => setOpen(!open())}>
        {open() ? "\u25BE" : "\u25B8"} {openCh()}
      </span>
      <Show
        when={open()}
        fallback={
          <span class="json-summary">
            {" "}
            {summary()} {closeCh()}
          </span>
        }
      >
        <span class="json-children">
          <For each={entries()}>
            {([key, val], i) => (
              <span class="json-child">
                <Show when={!isArray()}>
                  <span class="json-key">"{key}"</span>
                  <span class="json-colon">: </span>
                </Show>
                <JsonNode value={val} depth={props.depth + 1} />
                <Show when={i() < entries().length - 1}>
                  <span class="json-comma">,</span>
                </Show>
              </span>
            )}
          </For>
          <span class="json-close">{closeCh()}</span>
        </span>
      </Show>
    </Show>
  );
}

function Primitive(props: { value: unknown }) {
  const type = (): string => {
    if (props.value === null) return "null";
    if (typeof props.value === "string") return "string";
    if (typeof props.value === "number") return "number";
    if (typeof props.value === "boolean") return "boolean";
    return "other";
  };
  const display = (): string => {
    if (props.value === null) return "null";
    if (typeof props.value === "string") return `"${props.value}"`;
    return String(props.value);
  };

  return <span class={`json-value json-${type()}`}>{display()}</span>;
}
