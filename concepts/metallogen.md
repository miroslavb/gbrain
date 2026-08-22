---
type: concept
title: Metallogen
validate: false
ingested_via: 'mcp:put_page'
ingested_at: '2026-06-13T19:01:40.745Z'
source_kind: 'mcp:put_page'
tags:
  - 3d-generation
  - architector
  - metal-complexes
  - metallogen
  - pydentate
  - rdkit
  - recon3d
  - smiles
  - superseded
---

# MetalloGen — 3D Structure Generation for Metal Complexes

> ⚠️ **SUPERSEDED (2026-06-13) for BiometalDB.** The production 3D-reconstruction
> pipeline now uses **Architector + GFN2-xTB** with **pydentate** for coordinating
> atoms — see [[projects/biometaldb-3d-reconstruction]] (`scripts/recon3d/`). The
> dummy-atom/m-SMILES approach below is kept for reference; prefer recon3d for new
> work (it handles denticity, half-sandwich η5/η6, stereoisomers + Λ/Δ enantiomers,
> and emits TREXIO records).

## What
Tool for generating 3D coordinates of metal-organic complexes from SMILES notation. Converts m-SMILES (metal-annotated SMILES) → 3D geometry via dummy-atom embedding approach.

## Location
`/root/MetalloGen/MetalloGen/`

## Pipeline: m-SMILES → 3D
1. **m-SMILES format**: `[Metal]|[Ligand1:DonorSite]|[Ligand2:DonorSite]|geometry`
2. **Remove metal** from molecule
3. **Embed ligands** with `AllChem.EmbedMolecule(mol, AllChem.ETKDGv3())`
4. **Place metal** at centroid of donor atoms
5. **Merge coordinates** manually

## Patches required
- `/root/MetalloGen/MetalloGen/om.py`: add `if group is None: continue` (crashes on `[c-]` notation)
- `[Ir+3+3]` not parsed → use `[Ir+3]` only

## Open task (now solved in recon3d)
SMILES → m-SMILES converter needed. DB `smiles_ligands` has dot-separated ligands, `donor_atoms` is aggregate. Need SMARTS-based donor detection (N, O, S, `[c-]`) → atom map `:N`. **Resolved in recon3d via the pydentate ensemble GNN (coordinating-atom prediction).**

## Source
Session 2026-04-18, 2026-04-19; superseded note 2026-06-13.
