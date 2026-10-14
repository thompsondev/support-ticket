import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { bindReactionRole, listReactionRoles, unbindReactionRole } from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

export function parseEmoji(raw: string): { key: string; react: string } | null {
  const m = raw.trim().match(/^<a?:(\w+):(\d+)>$/);
  if (m) return { key: m[2], react: `${m[1]}:${m[2]}` };
  const uni = raw.trim();
  if (/^\p{Extended_Pictographic}/u.test(uni)) return { key: uni, react: uni };
  return null;
}

export const reactionrole: Command = {
  data: new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Reaction-role panels (staff)')
    .addSubcommand((s) =>
      s.setName('create').setDescription('Post a reaction-role panel')
        .addChannelOption((o) => o.setName('channel').setDescription('Target channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('title').setDescription('Panel title').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Panel description')),
    )
    .addSubcommand((s) =>
      s.setName('bind').setDescription('Bind an emoji to a role on a message')
        .addStringOption((o) => o.setName('message_id').setDescription('Message ID (right-click → Copy Message ID)').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji (unicode or <:name:id>)').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role to grant').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('unbind').setDescription('Remove an emoji binding')
        .addStringOption((o) => o.setName('message_id').setDescription('Message ID').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List bindings')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === 'create') {
      const channel = i.options.getChannel('channel', true);
      const ch = await i.guild.channels.fetch(channel.id).catch(() => null);
      if (!ch?.isSendable()) return void (await i.reply(ephemeral('Cannot post in that channel.')));
      const msg = await ch.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(i.options.getString('title', true))
            .setDescription(i.options.getString('description') ?? 'React below to get a role.')
            .setColor(COLORS.info),
        ],
      });
      await i.reply(
        ephemeral(`Panel posted. Bind roles with:\n\`/reactionrole bind message_id:${msg.id} emoji:<emoji> role:@Role\``),
      );
      return;
    }

    if (sub === 'list') {
      const rows = await listReactionRoles(i.guildId);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Reaction roles')
            .setColor(COLORS.info)
            .setDescription(
              rows
                .map((r) => `msg \`${r.message_id}\` — ${r.emoji} → <@&${r.role_id}>`)
                .join('\n') || 'No bindings.',
            ),
        ],
        flags: ephemeral('').flags,
      });
      return;
    }

    const messageId = i.options.getString('message_id', true);
    const em = parseEmoji(i.options.getString('emoji', true));
    if (!em) return void (await i.reply(ephemeral('Invalid emoji — use a unicode emoji or a server emoji like <:name:id>.')));

    if (sub === 'bind') {
      const role = i.options.getRole('role', true);
      // verify the message exists and get its channel
      let found = false;
      for (const [, chan] of i.guild.channels.cache) {
        if (!chan.isTextBased() || chan.isDMBased()) continue;
        const msg = await chan.messages.fetch(messageId).catch(() => null);
        if (msg) {
          await bindReactionRole(i.guildId, chan.id, messageId, em.key, role.id);
          await msg.react(em.react).catch(() => {});
          found = true;
          break;
        }
      }
      await i.reply(
        ephemeral(found ? `✅ ${i.options.getString('emoji', true)} → <@&${role.id}> bound.` : 'Message not found — check the ID.'),
      );
      return;
    }

    await i.reply(
      ephemeral(await unbindReactionRole(messageId, em.key) ? `🗑️ Binding removed.` : 'No binding for that emoji on that message.'),
    );
  },
};
