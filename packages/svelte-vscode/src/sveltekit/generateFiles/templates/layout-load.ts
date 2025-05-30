import { GenerateConfig, ProjectType, Resource } from '../types';

const defaultScriptTemplate = `
/** @type {import('./$types').LayoutLoad} */
export async function load() {
    return {};
}
`;

const tsScriptTemplate = `
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async () => {
    return {};
};
`;

const tsSatisfiesScriptTemplate = `
import type { LayoutLoad } from './$types';

export const load = (async () => {
    return {};
}) satisfies LayoutLoad;
`;

const scriptTemplate: ReadonlyMap<ProjectType, string> = new Map([
    [ProjectType.TS_SV5, tsScriptTemplate],
    [ProjectType.TS_SATISFIES_SV5, tsSatisfiesScriptTemplate],
    [ProjectType.JS_SV5, defaultScriptTemplate],
    [ProjectType.TS, tsScriptTemplate],
    [ProjectType.TS_SATISFIES, tsSatisfiesScriptTemplate],
    [ProjectType.JS, defaultScriptTemplate]
]);

export default async function (config: GenerateConfig): ReturnType<Resource['generate']> {
    return (scriptTemplate.get(config.type) ?? defaultScriptTemplate).trim();
}
