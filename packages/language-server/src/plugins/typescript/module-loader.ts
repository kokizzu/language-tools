import ts from 'typescript';
import { FileMap, FileSet } from '../../lib/documents/fileCollection';
import { createGetCanonicalFileName, getLastPartOfPath, toFileNameLowerCase } from '../../utils';
import { DocumentSnapshot } from './DocumentSnapshot';
import { createSvelteSys } from './svelte-sys';
import {
    ensureRealSvelteFilePath,
    getExtensionFromScriptKind,
    isSvelteFilePath,
    isVirtualSvelteFilePath
} from './utils';

const CACHE_KEY_SEPARATOR = ':::';
/**
 * Caches resolved modules.
 */
class ModuleResolutionCache {
    private cache = new FileMap<ts.ResolvedModule | undefined>();
    private pendingInvalidations = new FileSet();
    private getCanonicalFileName = createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames);

    /**
     * Tries to get a cached module.
     * Careful: `undefined` can mean either there's no match found, or that the result resolved to `undefined`.
     */
    get(moduleName: string, containingFile: string): ts.ResolvedModule | undefined {
        return this.cache.get(this.getKey(moduleName, containingFile));
    }

    /**
     * Checks if has cached module.
     */
    has(moduleName: string, containingFile: string): boolean {
        return this.cache.has(this.getKey(moduleName, containingFile));
    }

    /**
     * Caches resolved module (or undefined).
     */
    set(moduleName: string, containingFile: string, resolvedModule: ts.ResolvedModule | undefined) {
        this.cache.set(this.getKey(moduleName, containingFile), resolvedModule);
    }

    /**
     * Deletes module from cache. Call this if a file was deleted.
     * @param resolvedModuleName full path of the module
     */
    delete(resolvedModuleName: string): void {
        resolvedModuleName = this.getCanonicalFileName(resolvedModuleName);
        this.cache.forEach((val, key) => {
            if (val && this.getCanonicalFileName(val.resolvedFileName) === resolvedModuleName) {
                this.cache.delete(key);
                this.pendingInvalidations.add(key.split(CACHE_KEY_SEPARATOR).shift() || '');
            }
        });
    }

    /**
     * Deletes everything from cache that resolved to `undefined`
     * and which might match the path.
     */
    deleteUnresolvedResolutionsFromCache(path: string): void {
        const fileNameWithoutEnding =
            getLastPartOfPath(this.getCanonicalFileName(path)).split('.').shift() || '';
        this.cache.forEach((val, key) => {
            if (val) {
                return;
            }
            const [containingFile, moduleName = ''] = key.split(CACHE_KEY_SEPARATOR);
            if (moduleName.includes(fileNameWithoutEnding)) {
                this.cache.delete(key);
                this.pendingInvalidations.add(containingFile);
            }
        });
    }

    private getKey(moduleName: string, containingFile: string) {
        return containingFile + CACHE_KEY_SEPARATOR + ensureRealSvelteFilePath(moduleName);
    }

    clearPendingInvalidations() {
        this.pendingInvalidations.clear();
    }

    oneOfResolvedModuleChanged(path: string) {
        return this.pendingInvalidations.has(path);
    }
}

class ImpliedNodeFormatResolver {
    constructor(private readonly tsSystem: ts.System) {}

    resolve(
        importPath: string,
        importIdxInFile: number,
        sourceFile: ts.SourceFile | undefined,
        compilerOptions: ts.CompilerOptions
    ) {
        if (isSvelteFilePath(importPath)) {
            // Svelte imports should use the old resolution algorithm, else they are not found
            return undefined;
        }

        let mode: ReturnType<typeof ts.getModeForResolutionAtIndex> = undefined;
        if (sourceFile) {
            mode = ts.getModeForResolutionAtIndex(sourceFile, importIdxInFile, compilerOptions);
        }
        return mode;
    }

    resolveForTypeReference(
        entry: string | ts.FileReference,
        sourceFile: ts.SourceFile | undefined
    ) {
        let mode = undefined;
        if (sourceFile) {
            mode = ts.getModeForFileReference(entry, sourceFile?.impliedNodeFormat);
        }
        return mode;
    }
}

// https://github.com/microsoft/TypeScript/blob/dddd0667f012c51582c2ac92c08b8e57f2456587/src/compiler/program.ts#L989
function getTypeReferenceResolutionName<T extends ts.FileReference | string>(entry: T) {
    return typeof entry !== 'string' ? toFileNameLowerCase(entry.fileName) : entry;
}

/**
 * Creates a module loader specifically for `.svelte` files.
 *
 * The typescript language service tries to look up other files that are referenced in the currently open svelte file.
 * For `.ts`/`.js` files this works, for `.svelte` files it does not by default.
 * Reason: The typescript language service does not know about the `.svelte` file ending,
 * so it assumes it's a normal typescript file and searches for files like `../Component.svelte.ts`, which is wrong.
 * In order to fix this, we need to wrap typescript's module resolution and reroute all `.svelte.ts` file lookups to .svelte.
 *
 * @param getSnapshot A function which returns a (in case of svelte file fully preprocessed) typescript/javascript snapshot
 * @param compilerOptions The typescript compiler options
 */
export function createSvelteModuleLoader(
    getSnapshot: (fileName: string) => DocumentSnapshot,
    compilerOptions: ts.CompilerOptions,
    tsSystem: ts.System,
    tsModule: typeof ts,
    getModuleResolutionHost: () => ts.ModuleResolutionHost | undefined
) {
    const getCanonicalFileName = createGetCanonicalFileName(tsSystem.useCaseSensitiveFileNames);
    const svelteSys = createSvelteSys(tsSystem);
    // tsModuleCache caches package.json parsing and module resolution for directory
    const tsModuleCache = tsModule.createModuleResolutionCache(
        tsSystem.getCurrentDirectory(),
        createGetCanonicalFileName(tsSystem.useCaseSensitiveFileNames)
    );
    const tsTypeReferenceDirectiveCache = tsModule.createTypeReferenceDirectiveResolutionCache(
        tsSystem.getCurrentDirectory(),
        getCanonicalFileName,
        undefined,
        tsModuleCache.getPackageJsonInfoCache()
    );
    const moduleCache = new ModuleResolutionCache();
    const typeReferenceCache = new Map<
        string,
        ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations
    >();

    const impliedNodeFormatResolver = new ImpliedNodeFormatResolver(tsSystem);
    const resolutionWithFailedLookup = new Set<
        ts.ResolvedModuleWithFailedLookupLocations & {
            files?: Set<string>;
        }
    >();
    const failedLocationInvalidated = new FileSet(tsSystem.useCaseSensitiveFileNames);
    const pendingFailedLocationCheck = new FileSet(tsSystem.useCaseSensitiveFileNames);

    return {
        svelteFileExists: svelteSys.svelteFileExists,
        fileExists: svelteSys.fileExists,
        readFile: svelteSys.readFile,
        readDirectory: svelteSys.readDirectory,
        deleteFromModuleCache: (path: string) => {
            svelteSys.deleteFromCache(path);
            moduleCache.delete(path);
        },
        deleteUnresolvedResolutionsFromCache: (path: string) => {
            svelteSys.deleteFromCache(path);
            moduleCache.deleteUnresolvedResolutionsFromCache(path);
            pendingFailedLocationCheck.add(path);

            tsModuleCache.clear();
            typeReferenceCache.clear();
        },
        resolveModuleNames,
        resolveTypeReferenceDirectiveReferences,
        mightHaveInvalidatedResolutions,
        clearPendingInvalidations,
        getModuleResolutionCache: () => tsModuleCache,
        invalidateFailedLocationResolution
    };

    function resolveModuleNames(
        moduleNames: string[],
        containingFile: string,
        _reusedNames: string[] | undefined,
        redirectedReference: ts.ResolvedProjectReference | undefined,
        options: ts.CompilerOptions,
        containingSourceFile?: ts.SourceFile | undefined
    ): Array<ts.ResolvedModule | undefined> {
        return moduleNames.map((moduleName, index) => {
            if (moduleCache.has(moduleName, containingFile)) {
                return moduleCache.get(moduleName, containingFile);
            }

            const resolvedModule = resolveModuleName(
                moduleName,
                containingFile,
                containingSourceFile,
                index,
                redirectedReference,
                options
            );

            cacheResolutionWithFailedLookup(resolvedModule, containingFile);

            moduleCache.set(moduleName, containingFile, resolvedModule?.resolvedModule);
            return resolvedModule?.resolvedModule;
        });
    }

    function resolveModuleName(
        name: string,
        containingFile: string,
        containingSourceFile: ts.SourceFile | undefined,
        index: number,
        redirectedReference: ts.ResolvedProjectReference | undefined,
        option: ts.CompilerOptions
    ): ts.ResolvedModuleWithFailedLookupLocations {
        const mode = impliedNodeFormatResolver.resolve(
            name,
            index,
            containingSourceFile,
            // use the same compiler options as resolveModuleName
            // otherwise it might not find the module because of inconsistent module resolution strategy
            redirectedReference?.commandLine.options ?? option
        );
        const resolvedModuleWithFailedLookup = tsModule.resolveModuleName(
            name,
            containingFile,
            compilerOptions,
            getModuleResolutionHost() ?? svelteSys,
            tsModuleCache,
            redirectedReference,
            mode
        );

        const resolvedModule = resolvedModuleWithFailedLookup.resolvedModule;

        if (!resolvedModule || !isVirtualSvelteFilePath(resolvedModule.resolvedFileName)) {
            return resolvedModuleWithFailedLookup;
        }

        const resolvedFileName = svelteSys.getRealSveltePathIfExists(
            resolvedModule.resolvedFileName
        );

        if (!isSvelteFilePath(resolvedFileName)) {
            return resolvedModuleWithFailedLookup;
        }

        const snapshot = getSnapshot(resolvedFileName);

        const resolvedSvelteModule: ts.ResolvedModuleFull = {
            extension: getExtensionFromScriptKind(snapshot && snapshot.scriptKind),
            resolvedFileName,
            isExternalLibraryImport: resolvedModule.isExternalLibraryImport
        };
        return {
            ...resolvedModuleWithFailedLookup,
            resolvedModule: resolvedSvelteModule
        };
    }

    function resolveTypeReferenceDirectiveReferences<T extends ts.FileReference | string>(
        typeDirectiveNames: readonly T[],
        containingFile: string,
        redirectedReference: ts.ResolvedProjectReference | undefined,
        options: ts.CompilerOptions,
        containingSourceFile: ts.SourceFile | undefined
    ): readonly ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations[] {
        return typeDirectiveNames.map((typeDirectiveName) => {
            const entry = getTypeReferenceResolutionName(typeDirectiveName);
            const mode = impliedNodeFormatResolver.resolveForTypeReference(
                entry,
                containingSourceFile
            );

            const key = `${entry}|${mode}`;
            let result = typeReferenceCache.get(key);
            if (!result) {
                result = ts.resolveTypeReferenceDirective(
                    entry,
                    containingFile,
                    options,
                    {
                        ...tsSystem
                    },
                    redirectedReference,
                    tsTypeReferenceDirectiveCache,
                    mode
                );

                typeReferenceCache.set(key, result);
            }

            return result;
        });
    }

    function mightHaveInvalidatedResolutions(path: string) {
        return (
            moduleCache.oneOfResolvedModuleChanged(path) ||
            // tried but failed file might now exist
            failedLocationInvalidated.has(path)
        );
    }

    function clearPendingInvalidations() {
        moduleCache.clearPendingInvalidations();
        failedLocationInvalidated.clear();
        pendingFailedLocationCheck.clear();
    }

    function cacheResolutionWithFailedLookup(
        resolvedModule: ts.ResolvedModuleWithFailedLookupLocations & {
            files?: Set<string>;
        },
        containingFile: string
    ) {
        if (!resolvedModule.failedLookupLocations?.length) {
            return;
        }

        // The resolvedModule object will be reused in different files. A bit hacky, but TypeScript also does this.
        // https://github.com/microsoft/TypeScript/blob/11e79327598db412a161616849041487673fadab/src/compiler/resolutionCache.ts#L1103
        resolvedModule.files ??= new Set();
        resolvedModule.files.add(containingFile);
        resolutionWithFailedLookup.add(resolvedModule);
    }

    function invalidateFailedLocationResolution() {
        resolutionWithFailedLookup.forEach((resolvedModule) => {
            if (
                !resolvedModule.resolvedModule ||
                !resolvedModule.files ||
                !resolvedModule.failedLookupLocations
            ) {
                return;
            }
            for (const location of resolvedModule.failedLookupLocations) {
                if (pendingFailedLocationCheck.has(location)) {
                    moduleCache.delete(resolvedModule.resolvedModule.resolvedFileName);
                    resolvedModule.files?.forEach((file) => {
                        failedLocationInvalidated.add(file);
                    });
                    break;
                }
            }
        });

        pendingFailedLocationCheck.clear();
    }
}
