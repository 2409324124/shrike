import { create } from "zustand";
import type { ActionRecipe, RecipeSettings } from "@shrike/schema";
import { call } from "../lib/api.ts";
import { toast, useUi } from "../stores/ui.ts";

// S8: the Recipes tab of the skill shelf.

interface RecipesState {
  open: boolean; // the shelf shows Recipes instead of skills
  list: ActionRecipe[];
  load(): Promise<void>;
  save(id: string, s: RecipeSettings, scope: "project" | "personal"): Promise<boolean>;
  reset(id: string): Promise<void>;
}

export const useRecipes = create<RecipesState>((set) => ({
  open: false,
  list: [],
  async load() {
    const list = await call((a) => a.listRecipes(), "Couldn't load the recipes");
    if (list) set({ list });
  },
  async save(id, s, scope) {
    const list = await call((a) => a.saveRecipe(id, s, scope), "Couldn't save the recipe");
    if (!list) return false;
    set({ list });
    if (scope === "personal") toast("Saved as your default for every project.", "ok");
    return true;
  },
  async reset(id) {
    const list = await call((a) => a.resetRecipe(id), "Couldn't reset the recipe");
    if (list) set({ list });
  },
}));

/** Slash and voice "recipes": the skill shelf, on its Recipes tab. */
export function openRecipes(): void {
  useRecipes.setState({ open: true });
  useUi.setState({ panel: "skills", sheet: null });
}
