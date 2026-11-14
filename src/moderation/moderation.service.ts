import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ModerationInputItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAiModerationResponse {
  results?: Array<{
    flagged?: boolean;
    categories?: Record<string, boolean>;
    category_scores?: Record<string, number>;
  }>;
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);
  private missingKeyWarned = false;

  constructor(private readonly config: ConfigService) {}

  async assertSafeContent(params: {
    texts?: Array<string | null | undefined>;
    images?: Array<string | null | undefined>;
  }): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      if (!this.missingKeyWarned) {
        this.missingKeyWarned = true;
        this.logger.warn(
          'OPENAI_API_KEY não configurada; moderação automática de conteúdo desativada.',
        );
      }
      return;
    }

    const input: ModerationInputItem[] = [];

    for (const raw of params.texts ?? []) {
      const text = raw?.trim();
      if (text) {
        input.push({ type: 'text', text });
      }
    }

    for (const raw of params.images ?? []) {
      const url = raw?.trim();
      if (
        url &&
        (url.startsWith('https://') ||
          url.startsWith('data:image/jpeg') ||
          url.startsWith('data:image/png') ||
          url.startsWith('data:image/gif'))
      ) {
        input.push({ type: 'image_url', image_url: { url } });
      }
    }

    if (input.length === 0) return;

    const textItems = input.filter((item) => item.type === 'text');
    const imageItems = input.filter((item) => item.type === 'image_url');

    if (textItems.length > 0) {
      await this.checkModeration(apiKey, textItems, false);
    }

    for (const img of imageItems) {
      await this.checkModeration(apiKey, [img], false);
    }
  }

  async classifyImage(rawUrl?: string | null): Promise<{ isNsfw: boolean }> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    const url = rawUrl?.trim();
    if (!apiKey || !url) return { isNsfw: false };
    if (
      !url.startsWith('https://') &&
      !url.startsWith('data:image/jpeg') &&
      !url.startsWith('data:image/png') &&
      !url.startsWith('data:image/gif')
    ) {
      return { isNsfw: false };
    }
    return this.checkModeration(apiKey, [{ type: 'image_url', image_url: { url } }], true);
  }

  private async checkModeration(
    apiKey: string,
    input: ModerationInputItem[],
    allowAdultNsfw: boolean,
  ): Promise<{ isNsfw: boolean }> {
    try {
      const res = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'omni-moderation-latest',
          input,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        this.logger.error(`OpenAI Moderation retornou HTTP ${res.status}: ${detail}`);
        return { isNsfw: false };
      }

      const data = (await res.json()) as OpenAiModerationResponse;
      const isImageOnly = input.every((i) => i.type === 'image_url');
      if (isImageOnly && data.results?.[0]) {
        const r0 = data.results[0];
        this.logger.log(
          `Image moderation: flagged=${Boolean(r0.flagged)} sexual=${Boolean(r0.categories?.['sexual'])} score=${(r0.category_scores?.['sexual'] ?? 0).toFixed(3)}`,
        );
      }
      let isNsfw = false;

      const flaggedResult = data.results?.find((r) => {
        if (!r.flagged) return false;
        const cats = r.categories ?? {};
        const scores = r.category_scores ?? {};

        if (!isImageOnly) {
          return Boolean(
            cats['sexual'] ||
              cats['sexual/minors'] ||
              cats['self-harm'] ||
              cats['self-harm/intent'] ||
              cats['self-harm/instructions'] ||
              cats['hate/threatening'],
          );
        }

        if (
          cats['sexual/minors'] ||
          cats['self-harm'] ||
          cats['self-harm/intent'] ||
          cats['self-harm/instructions'] ||
          cats['violence/graphic'] ||
          (Boolean(cats['violence']) && (scores['violence'] ?? 0) >= 0.85)
        ) {
          return true;
        }

        if (cats['sexual']) {
          if (allowAdultNsfw) {
            isNsfw = true;
            return false;
          }
          return true;
        }

        return false;
      });

      if (flaggedResult) {
        const categories = Object.entries(flaggedResult.categories ?? {})
          .filter(([, v]) => Boolean(v))
          .map(([k]) => k)
          .join(', ');
        this.logger.warn(
          `Moderação bloqueou (${input.map((i) => i.type).join(', ')}): ${categories || 'sem categoria'}`,
        );
        throw new BadRequestException(
          'Conteúdo bloqueado pela moderação por violar as diretrizes da comunidade.',
        );
      }

      return { isNsfw };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(
        `Falha ao consultar OpenAI Moderation: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { isNsfw: false };
    }
  }
}