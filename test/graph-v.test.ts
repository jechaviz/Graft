/**
 * Tests for V (vlang) extraction in the Tier-1 code graph. Builds a small V module
 * in a temp dir and asserts the emitted nodes (funcs, methods, structs, interfaces,
 * enums, type aliases, constants) and edges (calls, imports) match the AST walk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const MAIN_V = `module main

import os
import mymod.util
import mymod.util { helper }

pub type ID = int

pub struct Base {
pub mut:
\tid int
}

pub fn (b Base) BaseMethod() {}

pub struct User {
\tBase
pub mut:
\tname string
}

pub interface Reader {
\tread() ?string
}

pub enum Status {
\tpending
\tactive
\tdone
}

pub const (
\tversion = "1.0.0"
)

pub fn Foo() {
\tprintln("hi")
\tutil.helper()
\thelper()
}

fn bar() {}

pub fn (u &User) Save() {
\tFoo()
\tu.name()
}

fn (u User) name() string {
\treturn u.name
}

fn consume_reader(r Reader) {
\tr.read()
}

fn main() {
\tu := User{name: "Alice"}
\tu.Save()
\tu.BaseMethod()
\tbar()
}
`;

const UTIL_V = `module util

pub fn helper() {}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-v-"));
  writeFileSync(join(dir, "main.v"), MAIN_V);
  mkdirSync(join(dir, "mymod", "util"), { recursive: true });
  writeFileSync(join(dir, "mymod", "util", "util.v"), UTIL_V);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("V extraction: funcs, methods, structs, interfaces, enums, types, constants", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir);
    assert.ok(result.languages.includes("v"), "languages should include v");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    // functions — exported by pub
    const foo = nodeById(graph!, "main.v#Foo");
    assert.equal(foo?.kind, "function");
    assert.equal(foo?.exported, true);
    const bar = nodeById(graph!, "main.v#bar");
    assert.equal(bar?.kind, "function");
    assert.equal(bar?.exported, false);

    // methods — receiver-qualified name, exported by pub
    const save = nodeById(graph!, "main.v#User.Save");
    assert.equal(save?.kind, "method");
    assert.equal(save?.exported, true);
    assert.equal(save?.owner, "User");

    const name = nodeById(graph!, "main.v#User.name");
    assert.equal(name?.kind, "method");
    assert.equal(name?.exported, false);
    assert.equal(name?.owner, "User");

    // types, structs, interfaces, enums
    const base = nodeById(graph!, "main.v#Base");
    assert.equal(base?.kind, "struct");

    const user = nodeById(graph!, "main.v#User");
    assert.equal(user?.kind, "struct");
    assert.equal(user?.exported, true);

    const reader = nodeById(graph!, "main.v#Reader");
    assert.equal(reader?.kind, "interface");
    assert.equal(reader?.exported, true);

    // interface methods extracted as method nodes
    const readerRead = nodeById(graph!, "main.v#Reader.read");
    assert.equal(readerRead?.kind, "method");
    assert.equal(readerRead?.owner, "Reader");
    assert.equal(readerRead?.exported, true);

    // struct embedding inheritance: User extends Base
    const userExtendsBase = graph!.edges.find(
      (e) => e.relation === "extends" && e.source === "main.v#User" && e.target === "Base",
    );
    assert.ok(userExtendsBase, "User should have an extends edge to Base");

    const status = nodeById(graph!, "main.v#Status");
    assert.equal(status?.kind, "enum");
    assert.equal(status?.exported, true);

    const idType = nodeById(graph!, "main.v#ID");
    assert.equal(idType?.kind, "type");
    assert.equal(idType?.exported, true);

    // constants
    const ver = nodeById(graph!, "main.v#version");
    assert.equal(ver?.kind, "constant");
    assert.equal(ver?.exported, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V extraction: call and import edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // same-file plain call resolves: Save() → Foo()
    const callFoo = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "main.v#User.Save" && e.target === "main.v#Foo",
    );
    assert.ok(callFoo, "User.Save should have a resolved calls edge to Foo");

    // cross-module function call resolves: Foo() → util.helper()
    const callHelper = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === "main.v#Foo" &&
        e.target === "mymod/util/util.v#helper",
    );
    assert.ok(callHelper, "Foo should have a resolved calls edge to mymod/util/util.v#helper");

    // member call `u.name()` resolves to the receiver method by its bare name
    const memberCall = graph.edges.find(
      (e) =>
        e.relation === "calls" && e.source === "main.v#User.Save" && e.target === "main.v#User.name",
    );
    assert.ok(memberCall, "User.Save should have a resolved calls edge to User.name");

    // local binding call `u.Save()` inside main() resolves to User.Save
    const mainCallsSave = graph.edges.find(
      (e) =>
        e.relation === "calls" && e.source === "main.v#main" && e.target === "main.v#User.Save",
    );
    assert.ok(mainCallsSave, "main should have a resolved calls edge to User.Save via local binding");

    // embedded struct method call: `u.BaseMethod()` inside main() resolves to Base.BaseMethod via inheritance
    const mainCallsBase = graph.edges.find(
      (e) =>
        e.relation === "calls" && e.source === "main.v#main" && e.target === "main.v#Base.BaseMethod",
    );
    assert.ok(mainCallsBase, "main should resolve u.BaseMethod() to Base.BaseMethod through struct embedding");

    // interface method call: `r.read()` inside consume_reader resolves to Reader.read
    const callRead = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === "main.v#consume_reader" &&
        e.target === "main.v#Reader.read",
    );
    assert.ok(callRead, "consume_reader should resolve r.read() to Reader.read");

    // in-repo import resolves to file node: import mymod.util → mymod/util/util.v
    const importUtil = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "main.v" && e.target === "mymod/util/util.v",
    );
    assert.ok(importUtil, "mymod.util should resolve to mymod/util/util.v");

    // external import os
    const importOs = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "main.v" && e.target === "os",
    );
    assert.ok(importOs, "os should be recorded as an import edge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
