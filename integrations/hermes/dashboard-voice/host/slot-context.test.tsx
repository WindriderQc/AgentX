import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PluginSlot, registerSlot, unregisterPluginSlots } from "./slots";

it("passes the current host context to an existing slot without replacing chat", () => {
  function Probe({ chat }: { chat?: { channel: string } }) {
    return <span>{chat?.channel}</span>;
  }
  registerSlot("context-probe", "chat:top", Probe);
  expect(renderToStaticMarkup(<PluginSlot name="chat:top" context={{ chat: { channel: "first-chat" } }} />)).toContain("first-chat");
  expect(renderToStaticMarkup(<PluginSlot name="chat:top" context={{ chat: { channel: "second-chat" } }} />)).toContain("second-chat");
  unregisterPluginSlots("context-probe");
});
