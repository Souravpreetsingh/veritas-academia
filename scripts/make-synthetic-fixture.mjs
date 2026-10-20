#!/usr/bin/env node
// Generates the synthetic local-test fixture for the document-analysis pipeline.
//
// The output is a FICTIONAL academic-style essay used only for local development
// smoke tests. It contains no real student work, no real people, no real data,
// and no credentials. It deliberately:
//
//   * includes one short public-domain quotation that appears verbatim in the
//     bundled local corpus (src/lib/analysis/local-corpus.ts), so a
//     LOCAL_SIMILARITY run has a real, non-fabricated match to report; and
//   * includes one unattributed quotation, so the LLM citation-review
//     assistance has a plausible passage to flag.
//
// The essay text below IS the fixture source of truth; regenerate the .docx
// any time with:
//
//   node scripts/make-synthetic-fixture.mjs
//
// Output: local-test-fixtures/synthetic-academic-essay.docx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "local-test-fixtures");
const outFile = path.join(outDir, "synthetic-academic-essay.docx");

// ---------------------------------------------------------------------------
// Fixture text (fictional)
// ---------------------------------------------------------------------------

const PARAGRAPHS = [
  "SYNTHETIC TEST DOCUMENT — created for local software testing; not a real student submission.",

  "Tending the Commons: Urban Community Gardens and Civic Resilience",

  "Prepared by: Test Fixture (fictional author)",

  "Introduction",

  "Cities are often described through their hard edges — highways, towers, and transit lines — yet some of their most durable institutions are soft ones. Community gardens occupy vacant lots, schoolyards, and rooftops, and they persist because residents maintain them rather than because anyone profits from them. This essay argues that urban gardens matter less for the vegetables they produce than for the civic habits they cultivate: negotiation, shared maintenance, and a working trust between neighbours who might otherwise never meet.",

  "A famous epigraph from the English novel offers a useful starting point: \"It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.\" The line is satirical, but its structure is instructive — communities tend to treat certain arrangements as self-evident long before anyone has tested them. Gardens, too, are often justified by assumptions rather than evidence.",

  "The Social Life of a Raised Bed",

  "A raised bed is a small piece of infrastructure with an unusually large social footprint. Because it cannot be locked or automated, it forces recurring cooperation: watering schedules, tool sharing, and decisions about what counts as a weed. Studies of small-scale urban agriculture repeatedly observe that a garden's governance, not its soil chemistry, determines whether it survives beyond the first season. As one planner is said to have written, \"a garden is a conversation between a neighbourhood and its soil\", though the phrase circulates without a traceable author — which is itself a small lesson about citation habits.",

  "Maintenance also produces what economists might call positive externalities. Neighbours report meeting one another at the fence line; informal oversight increases as more people pass through a block during daylight; and vacant lots stop functioning as dumping grounds. These effects are real but difficult to price, which may explain why municipal support for gardens is so uneven.",

  "Institutional Support and Its Discontents",

  "Where gardens depend on grant cycles, their social life bends around paperwork. A plot that exists because residents want it can adapt quickly; a plot that exists because a programme funds it must satisfy reporting templates that rarely measure the things gardeners value. This mismatch is not unique to gardens, but it is unusually visible in them, because the gap between what is measured — harvest pounds, volunteer hours — and what matters — relationships, belonging, informal learning — is so wide.",

  "Critics of urban agriculture raise a fair objection: in cities with severe housing shortages, land held as gardens could hold homes. The strongest version of this critique does not oppose gardens as such; it opposes the permanent dedication of scarce central land to uses that serve relatively few residents. A serious policy therefore treats gardens as part of a mixed portfolio — temporary uses on sites awaiting development, permanent uses where land is abundant or already protected — rather than as a moral absolute.",

  "Measuring What Gardens Grow",

  "Any honest evaluation has to start by admitting how little standardised data exists. Municipal inventories count plots, not participation; surveys capture snapshots, not seasons; and the most important outcomes — trust, skills, friendships — resist measurement entirely. It would be easy to invent a tidy statistic here, but the responsible move is to state the limitation plainly: gardens are studied with weak instruments, and confident numbers in advocacy documents should be read with care.",

  "Conclusion",

  "Community gardens are better understood as civic infrastructure than as food production. They are small, local, and stubbornly social — three properties that make them both resilient and hard to govern at scale. The question for cities is not whether gardens can feed a metropolis; they cannot. The question is whether the habits they build are worth the land they hold, and that question has to be answered block by block.",

  "References (illustrative; fictional)",

  "Doe, J. (2019). Raised beds and local governance. Journal of Urban Placeholders, 4(2), 11–24.",

  "Roe, A. (2021). Measuring belonging in small green spaces. Fictional Review of Civic Studies, 7(1), 3–19.",

  "Poe, L. (2023). Vacant lots, community use, and the limits of grant cycles. Test Corpus Quarterly, 1(1), 55–61.",
];

// ---------------------------------------------------------------------------
// Minimal, valid DOCX (Office Open XML) container
// ---------------------------------------------------------------------------

function xmlEscape(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function paragraphXml(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${PARAGRAPHS.map((p) => `    ${paragraphXml(p)}`).join("\n")}
    <w:sectPr/>
  </w:body>
</w:document>`;

const zip = new JSZip();
zip.file("[Content_Types].xml", CONTENT_TYPES);
zip.file("_rels/.rels", ROOT_RELS);
zip.file("word/document.xml", DOCUMENT_XML);

const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, buffer);

const words = PARAGRAPHS.join(" ").split(/\s+/).filter(Boolean).length;
console.log(`Wrote ${path.relative(root, outFile)} (${buffer.length} bytes, ~${words} words).`);
