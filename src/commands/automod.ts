import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { deleteAutomodRule, getAutomodRule, getConfig, setAutomodRule } from '../db';
import { COLORS, ephemeral } from '../util';
import type { Command } from './index';

async function upsertRule(
  i: ChatInputCommandInteraction<'cached'>,
  kind: string,
  def: {
    name: string;
    triggerType: AutoModerationRuleTriggerType;
    triggerMetadata?: Record<string, unknown>;
  },
) {
  const cfg = await getConfig(i.guildId);
  const actions = [
    { type: AutoModerationActionType.BlockMessage },
    ...(cfg.log_channel_id
      ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: cfg.log_channel_id } }]
      : []),
  ];
  const existing = await getAutomodRule(i.guildId, kind);
  if (existing) {
    const rule = await i.guild.autoModerationRules.fetch(existing).catch(() => null);
    if (rule) {
      await rule.edit({
        triggerMetadata: def.triggerMetadata as never,
        actions,
      });
      return rule.id;
    }
  }
  const rule = await i.guild.autoModerationRules.create({
    name: def.name,
    eventType: AutoModerationRuleEventType.MessageSend,
    triggerType: def.triggerType,
    triggerMetadata: def.triggerMetadata as never,
    actions,
    enabled: true,
  });
  await setAutomodRule(i.guildId, kind, rule.id);
  return rule.id;
}

async function disableRule(i: ChatInputCommandInteraction<'cached'>, kind: string): Promise<boolean> {
  const id = await getAutomodRule(i.guildId, kind);
  if (!id) return false;
  const rule = await i.guild.autoModerationRules.fetch(id).catch(() => null);
  if (rule) await rule.delete().catch(() => {});
  await deleteAutomodRule(i.guildId, kind);
  return true;
}

export const automod: Command = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Native Discord AutoMod rules (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s.setName('keywords').setDescription('Block messages containing words')
        .addStringOption((o) => o.setName('words').setDescription('Comma-separated words/phrases').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('spam').setDescription('Native spam detection')
        .addBooleanOption((o) => o.setName('enabled').setDescription('on/off').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('mentions').setDescription('Block mass-mention spam')
        .addIntegerOption((o) => o.setName('limit').setDescription('Max mentions per message (0 = off)').setRequired(true).setMinValue(0).setMaxValue(50)),
    )
    .addSubcommand((s) =>
      s.setName('invites').setDescription('Block Discord invite links')
        .addBooleanOption((o) => o.setName('enabled').setDescription('on/off').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Show configured rules')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await i.reply(ephemeral('You need Manage Server.'));
      return;
    }
    const sub = i.options.getSubcommand();

    try {
      switch (sub) {
        case 'keywords': {
          const words = i.options.getString('words', true).split(',').map((w) => w.trim()).filter(Boolean).slice(0, 1000);
          if (!words.length) return void (await i.reply(ephemeral('No words provided.')));
          await upsertRule(i, 'keywords', {
            name: 'TicketBot keyword filter',
            triggerType: AutoModerationRuleTriggerType.Keyword,
            triggerMetadata: { keywordFilter: words },
          });
          await i.reply(ephemeral(`🛡️ Keyword filter active — ${words.length} term(s) blocked.`));
          break;
        }
        case 'spam': {
          if (i.options.getBoolean('enabled', true)) {
            await upsertRule(i, 'spam', { name: 'TicketBot anti-spam', triggerType: AutoModerationRuleTriggerType.Spam });
            await i.reply(ephemeral('🛡️ Spam detection enabled.'));
          } else {
            await disableRule(i, 'spam');
            await i.reply(ephemeral('Spam detection disabled.'));
          }
          break;
        }
        case 'mentions': {
          const limit = i.options.getInteger('limit', true);
          if (limit === 0) {
            await disableRule(i, 'mentions');
            await i.reply(ephemeral('Mention-spam protection disabled.'));
          } else {
            await upsertRule(i, 'mentions', {
              name: 'TicketBot mention spam',
              triggerType: AutoModerationRuleTriggerType.MentionSpam,
              triggerMetadata: { mentionTotalLimit: limit },
            });
            await i.reply(ephemeral(`🛡️ Messages with >${limit} mentions will be blocked.`));
          }
          break;
        }
        case 'invites': {
          if (i.options.getBoolean('enabled', true)) {
            await upsertRule(i, 'invites', {
              name: 'TicketBot invite blocker',
              triggerType: AutoModerationRuleTriggerType.Keyword,
              triggerMetadata: {
                regexPatterns: ['discord\\.gg', 'discord(?:app)?\\.com/invite', 'dsc\\.gg', 'discord\\.link'],
              },
            });
            await i.reply(ephemeral('🛡️ Invite links will be blocked.'));
          } else {
            await disableRule(i, 'invites');
            await i.reply(ephemeral('Invite blocking disabled.'));
          }
          break;
        }
        case 'status': {
          const rules = await i.guild.autoModerationRules.fetch().catch(() => null);
          await i.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('🛡️ AutoMod rules')
                .setColor(COLORS.info)
                .setDescription(
                  rules && rules.size
                    ? rules.map((r) => `**${r.name}** — ${r.enabled ? '✅ enabled' : '⏸️ paused'}`).join('\n')
                    : 'No rules configured.',
                ),
            ],
            flags: ephemeral('').flags,
          });
          break;
        }
      }
    } catch (err) {
      await i.reply(ephemeral(`AutoMod error — check the bot has Manage Server permission. (${String(err).slice(0, 120)})`));
    }
  },
};
