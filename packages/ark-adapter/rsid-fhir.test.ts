/** Synthetic site resources exercise mapping and refusal without storing personal data. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { readCatalog } from "@/scripts/genome-synth/read-catalog";
import { callsFor } from "@/scripts/genome-synth/genotypes";
import { reportFor } from "@/scripts/genome-synth/ark-report";
import { fhirFor } from "@/scripts/genome-synth/fhir";
import { parseRsidGenotypesReport } from "./rsid-genotypes";
import { parseRsidFhir } from "./rsid-fhir";
import fixture from "./fixtures/export-synthetic.json";

const catalog = await readCatalog();
const calls = callsFor("080b069b-5108-46b6-ecef-6aacd3b9ef3f", catalog);

test("the compact fixture is generated only from the seeded synthetic genome", async () => {
  expect(
    await readFile(new URL("./fixtures/export-synthetic.json", import.meta.url), "utf8"),
  ).toBe(JSON.stringify(fhirFor(calls)));
  const expected = parseRsidGenotypesReport(reportFor(calls, catalog));
  if (!expected.ok) throw new Error(expected.issue);
  expect(parseRsidFhir(fixture.bundle, fixture.paths)).toEqual({
    ok: true,
    arkBuild: "GRCh38.p14",
    rows: expected.rows,
  });
});

test("not granted differs from no record and an explicit fully uncalled genotype", () => {
  const absent = parseRsidFhir({ resourceType: "Bundle", type: "collection" }, []);
  if (!absent.ok) throw new Error(absent.issue);
  expect(absent.rows[0]).toEqual({
    rsid: "rs4244285",
    chromosome: null,
    position: null,
    reference: null,
    genotype: null,
    granted: false,
  });
  const noRecord = parseRsidFhir({ resourceType: "Bundle", type: "collection" }, [
    fixture.paths[0]!,
  ]);
  const uncalled = fhirFor(calls.map((call) => ({ ...call, altCopies: null })));
  const noCall = parseRsidFhir(uncalled.bundle, uncalled.paths);
  if (!noRecord.ok || !noCall.ok) throw new Error("synthetic no-call did not parse");
  const row = {
    rsid: "rs4244285",
    chromosome: "chr10",
    position: 94781859,
    reference: "G",
    genotype: null,
  };
  expect(noRecord.rows[0]).toEqual(row);
  expect(noCall.rows[0]).toEqual(row);
  expect(noRecord.arkBuild).toBe(null);
  expect(noCall.arkBuild).toBe("GRCh38.p14");
});

test("reference calls use the Absent Variant and alternate calls use Present", () => {
  for (const [altCopies, genotype] of [
    [0, "G/G"],
    [1, "G/A"],
    [2, "A/A"],
  ] as const) {
    const value = fhirFor(calls.map((call) => ({ ...call, altCopies })));
    const parsed = parseRsidFhir(value.bundle, value.paths);
    if (!parsed.ok) throw new Error(parsed.issue);
    expect(parsed.rows[0]).toEqual({
      rsid: "rs4244285",
      chromosome: "chr10",
      position: 94781859,
      reference: "G",
      genotype,
    });
  }
});

test("a multiallelic site joins each Variant and preserves genotype separators", () => {
  const value = structuredClone(fixture);
  const genotype = value.bundle.entry[0]!;
  genotype.resource.valueCodeableConcept.text = "|A|T";
  const alternate = structuredClone(value.bundle.entry[1]!);
  alternate.fullUrl = "urn:uuid:00000000-0000-5000-8000-000000000001";
  alternate.resource.id = alternate.fullUrl.slice(9);
  alternate.resource.component.find(
    (part) => part.code.coding[0]!.code === "69551-0",
  )!.valueString = "T";
  genotype.resource.derivedFrom!.push({ reference: alternate.fullUrl });
  value.bundle.entry.push(alternate);
  const parsed = parseRsidFhir(value.bundle, value.paths);
  if (!parsed.ok) throw new Error(parsed.issue);
  expect(parsed.rows[0]?.genotype).toBe("|A|T");
});

test("rsIDs identify a site when the Ark's coordinates differ from the panel", () => {
  const value = fhirFor(
    calls.map((call) =>
      call.variant.rsid === "rs4244285"
        ? { ...call, variant: { ...call.variant, pos: 94781860 } }
        : call,
    ),
  );
  const parsed = parseRsidFhir(value.bundle, value.paths);
  if (!parsed.ok) throw new Error(parsed.issue);
  expect(parsed.rows[0]).toEqual({
    rsid: "rs4244285",
    chromosome: "chr10",
    position: 94781860,
    reference: "G",
    genotype: "G/A",
  });
});

test("a site must name exactly one granted panel rsID", () => {
  for (const identifiers of [[], ["rs999999999"], ["rs4244285", "rs4986893"]]) {
    const value = structuredClone(fixture);
    const variant = value.bundle.entry[1]!.resource;
    const code = variant.component.find(
      (part) => part.code.coding[0]!.code === "81252-9",
    )!;
    variant.component = variant.component.filter(
      (part) => part.code.coding[0]!.code !== "81252-9",
    );
    for (const rsid of identifiers)
      variant.component.push({
        ...code,
        valueCodeableConcept: {
          coding: [{ system: "http://www.ncbi.nlm.nih.gov/projects/SNP", code: rsid }],
        },
      });
    expect(parseRsidFhir(value.bundle, value.paths)).toEqual({
      ok: false,
      issue: "report-unreadable",
    });
  }
});

test("every Variant at one site agrees on the rsID set regardless of order", () => {
  const value = structuredClone(fixture);
  const genotype = value.bundle.entry[0]!.resource;
  genotype.valueCodeableConcept.text = "A/T";
  const first = value.bundle.entry[1]!;
  const id = first.resource.component.find(
    (part) => part.code.coding[0]!.code === "81252-9",
  )!;
  first.resource.component.push({
    ...id,
    valueCodeableConcept: {
      coding: [
        { system: "http://www.ncbi.nlm.nih.gov/projects/SNP", code: "rs999999999" },
      ],
    },
  });
  const second = structuredClone(first);
  second.fullUrl = "urn:uuid:00000000-0000-5000-8000-000000000001";
  second.resource.id = second.fullUrl.slice(9);
  second.resource.component.find(
    (part) => part.code.coding[0]!.code === "69551-0",
  )!.valueString = "T";
  second.resource.component.reverse();
  genotype.derivedFrom!.push({ reference: second.fullUrl });
  value.bundle.entry.push(second);
  expect(parseRsidFhir(value.bundle, value.paths).ok).toBe(true);
  second.resource.component.find(
    (part) => part.code.coding[0]!.code === "81252-9",
  )!.valueCodeableConcept!.coding[0]!.code = "rs1000000000";
  expect(parseRsidFhir(value.bundle, value.paths)).toEqual({
    ok: false,
    issue: "report-unreadable",
  });
});

test("a no-call uses its rsID-path id even when its coordinates differ from the panel", () => {
  const value = fhirFor(calls.map((call) => ({ ...call, altCopies: null })));
  expect(value.bundle.entry[0]!.resource.id).toBe("ccf6ebba-2a38-5625-a668-5ef5fc3994e0");
  expect(value.bundle.entry[0]!.fullUrl).toBe(
    "urn:uuid:ccf6ebba-2a38-5625-a668-5ef5fc3994e0",
  );
  value.bundle.entry[0]!.resource.component.find(
    (part) => part.code.coding[0]!.code === "81254-5",
  )!.valueRange = { low: { value: 94781860 }, high: { value: 94781860 } };
  const parsed = parseRsidFhir(value.bundle, value.paths);
  if (!parsed.ok) throw new Error(parsed.issue);
  expect(parsed.rows[0]).toEqual({
    rsid: "rs4244285",
    chromosome: "chr10",
    position: 94781860,
    reference: "G",
    genotype: null,
  });
});

test("a no-call id must match a granted rsID even when its coordinates match the panel", () => {
  for (const id of [
    "00000000-0000-5000-8000-000000000001",
    "865b9b58-cf98-5be4-b349-7852d310fd24",
  ]) {
    const value = fhirFor(calls.map((call) => ({ ...call, altCopies: null })));
    value.bundle.entry[0]!.resource.id = id;
    value.bundle.entry[0]!.fullUrl = `urn:uuid:${id}`;
    expect(parseRsidFhir(value.bundle, value.paths)).toEqual({
      ok: false,
      issue: "report-unreadable",
    });
  }
  const value = fhirFor(calls.map((call) => ({ ...call, altCopies: null })));
  expect(parseRsidFhir(value.bundle, value.paths.slice(1))).toEqual({
    ok: false,
    issue: "report-unreadable",
  });
});

test("assembly text is preserved and its code is the fallback", () => {
  const value = structuredClone(fixture);
  for (const entry of value.bundle.entry) {
    const assembly = entry.resource.component.find(
      (part) => part.code.coding[0]!.code === "62374-4",
    )!;
    delete assembly.valueCodeableConcept!.text;
  }
  const parsed = parseRsidFhir(value.bundle, value.paths);
  if (!parsed.ok) throw new Error(parsed.issue);
  expect(parsed.arkBuild).toBe("GRCh38");
});

test("reference comes from the Variant rather than being replaced by the panel", () => {
  const value = structuredClone(fixture);
  value.bundle.entry[0]!.resource.valueCodeableConcept.text = "C/A";
  value.bundle.entry[1]!.resource.component.find(
    (part) => part.code.coding[0]!.code === "69547-8",
  )!.valueString = "C";
  const parsed = parseRsidFhir(value.bundle, value.paths);
  if (!parsed.ok) throw new Error(parsed.issue);
  expect(parsed.rows[0]).toEqual({
    rsid: "rs4244285",
    chromosome: "chr10",
    position: 94781859,
    reference: "C",
    genotype: "C/A",
  });
});

test("partly called and spanning-deletion genotypes keep their stored text", () => {
  for (const text of ["G/.", "G/*", "G/<DEL>"]) {
    const value = fhirFor(calls.map((call) => ({ ...call, altCopies: null })));
    value.bundle.entry[0]!.resource.valueCodeableConcept = { text };
    const parsed = parseRsidFhir(value.bundle, value.paths);
    if (!parsed.ok) throw new Error(parsed.issue);
    expect(parsed.rows[0]?.genotype).toBe(text);
    expect(parsed.rows[0]?.reference).toBe("G");
  }
});

test("an unknown assembly answer or disagreement with its text is refused", () => {
  for (const [code, issue] of [
    ["unknown", "BUILD_UNKNOWN"],
    ["LA14029-5", "BUILD_MISMATCH"],
  ]) {
    const value = structuredClone(fixture);
    value.bundle.entry[0]!.resource.component.find(
      (part) => part.code.coding[0]!.code === "62374-4",
    )!.valueCodeableConcept!.coding[0]!.code = code!;
    expect(parseRsidFhir(value.bundle, value.paths)).toEqual({
      ok: false,
      issue,
    });
  }
});

test("inconsistent resources fail with a fixed issue and no copied values", () => {
  const changes = [
    () => {
      const value = structuredClone(fixture);
      value.bundle.entry[0]!.resource.component.find(
        (part) => part.code.coding[0]!.code === "81254-5",
      )!.valueRange = { low: { value: 1 }, high: { value: 1 } };
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      const duplicate = structuredClone(value.bundle.entry[0]!);
      duplicate.fullUrl = "urn:uuid:00000000-0000-5000-8000-000000000001";
      duplicate.resource.id = duplicate.fullUrl.slice(9);
      value.bundle.entry.push(duplicate);
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      value.bundle.entry[1]!.resource.component.find(
        (part) => part.code.coding[0]!.code === "81254-5",
      )!.valueRange = { low: { value: 94780653 }, high: { value: 94780653 } };
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      value.bundle.entry.push(value.bundle.entry[0]!);
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      value.paths = [];
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      value.bundle.entry[0]!.resource.derivedFrom = [];
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      value.bundle.entry[0]!.resource.valueCodeableConcept.text = "private-content";
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      value.bundle.entry[0]!.resource.component.push(
        value.bundle.entry[0]!.resource.component[0]!,
      );
      return value;
    },
    () => {
      const value = structuredClone(fixture);
      value.bundle.entry.splice(0, 1);
      return value;
    },
  ];
  for (const change of changes) {
    const value = change();
    expect(parseRsidFhir(value.bundle, value.paths)).toEqual({
      ok: false,
      issue: "report-unreadable",
    });
  }
});

test("a GRCh37 assembly cannot be joined against GRCh38 panel coordinates", () => {
  const value = structuredClone(fixture);
  const assembly = value.bundle.entry[0]!.resource.component.find(
    (part) => part.code.coding[0]!.code === "62374-4",
  )!;
  assembly.valueCodeableConcept = {
    text: "GRCh37",
    coding: [{ system: "http://loinc.org", code: "LA14029-5", display: "GRCh37" }],
  };
  expect(parseRsidFhir(value.bundle, value.paths)).toEqual({
    ok: false,
    issue: "BUILD_MISMATCH",
  });
});
