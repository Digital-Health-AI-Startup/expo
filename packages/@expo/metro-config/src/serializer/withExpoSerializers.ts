/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { isJscSafeUrl, toNormalUrl } from 'jsc-safe-url';
import { MetroConfig, Module, ReadOnlyGraph } from 'metro';
import bundleToString from 'metro/src/lib/bundleToString';
import { ConfigT, InputConfigT } from 'metro-config';

import {
  environmentVariableSerializerPlugin,
  serverPreludeSerializerPlugin,
} from './environmentVariableSerializerPlugin';
import { Bundle, ExpoSerializerOptions, baseJSBundle } from './fork/baseJSBundle';
import { graphToSerialAssetsAsync } from './serializeChunks';
import { SerialAsset } from './serializerAssets';
import { env } from '../env';

export type Serializer = NonNullable<ConfigT['serializer']['customSerializer']>;

export type SerializerParameters = [
  string,
  readonly Module[],
  ReadOnlyGraph,
  ExpoSerializerOptions,
];

type SerializerConfigOptions = {
  dangerous_beforeChunkSerialization?: (...params: SerializerParameters) => SerializerParameters;
  dangerous_beforeChunkBundleToString?: (bundle: Bundle) => Bundle;
  dangerous_afterChunkSerialization?: (serializationOutput: { code: string; map?: string }) => {
    code: string;
    map?: string;
  };
};

// A serializer that processes the input and returns a modified version.
// Unlike a serializer, these can be chained together.
export type SerializerPlugin = (...props: SerializerParameters) => SerializerParameters;

export function withExpoSerializers(
  config: InputConfigT,
  options: SerializerConfigOptions = {}
): InputConfigT {
  const processors: SerializerPlugin[] = [];
  processors.push(serverPreludeSerializerPlugin);
  if (!env.EXPO_NO_CLIENT_ENV_VARS) {
    processors.push(environmentVariableSerializerPlugin);
  }

  return withSerializerPlugins(config, processors, options);
}

// There can only be one custom serializer as the input doesn't match the output.
// Here we simply run
export function withSerializerPlugins(
  config: InputConfigT,
  processors: SerializerPlugin[],
  options: SerializerConfigOptions = {}
): InputConfigT {
  const originalSerializer = config.serializer?.customSerializer;

  return {
    ...config,
    serializer: {
      ...config.serializer,
      customSerializer: createSerializerFromSerialProcessors(
        config,
        processors,
        originalSerializer ?? null,
        options
      ),
    },
  };
}

function getDefaultSerializer(
  config: MetroConfig,
  fallbackSerializer: Serializer | null,
  configOptions: SerializerConfigOptions = {}
): Serializer {
  return async (
    ...props: SerializerParameters
  ): Promise<string | { code: string; map: string }> => {
    const [, , , options] = props;

    const customSerializerOptions = options.serializerOptions;

    // Custom options can only be passed outside of the dev server, meaning
    // we don't need to stringify the results at the end, i.e. this is `npx expo export` or `npx expo export:embed`.
    const supportsNonSerialReturn = !!customSerializerOptions?.output;

    const serializerOptions = (() => {
      if (customSerializerOptions) {
        return {
          includeBytecode: customSerializerOptions.includeBytecode,
          outputMode: customSerializerOptions.output,
          includeSourceMaps: customSerializerOptions.includeSourceMaps,
        };
      }
      if (options.sourceUrl) {
        const sourceUrl = isJscSafeUrl(options.sourceUrl)
          ? toNormalUrl(options.sourceUrl)
          : options.sourceUrl;

        const url = new URL(sourceUrl, 'https://expo.dev');

        return {
          outputMode: url.searchParams.get('serializer.output'),
          includeSourceMaps: url.searchParams.get('serializer.map') === 'true',
          includeBytecode: url.searchParams.get('serializer.bytecode') === 'true',
        };
      }
      return null;
    })();

    if (serializerOptions?.outputMode !== 'static') {
      const defaultSerializer =
        fallbackSerializer ??
        (async (...params: SerializerParameters) => {
          const bundle = baseJSBundle(...params);
          const outputCode = bundleToString(bundle).code;
          return outputCode;
        });
      return defaultSerializer(...props);
    }

    // Mutate the serializer options with the parsed options.
    options.serializerOptions = {
      ...options.serializerOptions,
      ...serializerOptions,
    };

    const assets = await graphToSerialAssetsAsync(
      config,
      {
        includeSourceMaps: !!serializerOptions.includeSourceMaps,
        includeBytecode: !!serializerOptions.includeBytecode,
        ...configOptions,
      },
      ...props
    );

    if (supportsNonSerialReturn) {
      // @ts-expect-error: this is future proofing for adding assets to the output as well.
      return assets;
    }

    return JSON.stringify(assets);
  };
}

export function createSerializerFromSerialProcessors(
  config: MetroConfig,
  processors: (SerializerPlugin | undefined)[],
  originalSerializer: Serializer | null,
  options: SerializerConfigOptions = {}
): Serializer {
  const finalSerializer = getDefaultSerializer(config, originalSerializer, options);
  return (...props: SerializerParameters): ReturnType<Serializer> => {
    for (const processor of processors) {
      if (processor) {
        props = processor(...props);
      }
    }

    return finalSerializer(...props);
  };
}

export { SerialAsset };
