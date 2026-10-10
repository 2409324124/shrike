---
name: Fix merge conflicts
when: A sync with main or a merge stopped because files have conflicts
kind: git
---

# Fix merge conflicts

1. List the conflicted files. Read each one around its conflict markers with read_file.
2. For each conflict, work out what each side meant, not just which lines differ.
3. Keep what both sides meant. When they truly disagree, prefer the incoming change and say why.
4. For each file, call propose_patch once, replacing every whole conflict block (from the <<<<<<< line to the >>>>>>> line) with the resolved code.
5. Don't touch files without conflicts. The user applies each file's fix.
6. After the last file, Shrike finishes the sync and re-runs the saved flows to prove nothing broke.
