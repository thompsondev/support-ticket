import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { AttachmentBuilder, GuildMember } from 'discord.js';

const W = 900;
const H = 300;

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function welcomeCard(member: GuildMember): Promise<AttachmentBuilder | null> {
  try {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // background: dark gradient + accent bar
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#1e1f22');
    grad.addColorStop(1, '#2b2d31');
    roundRect(ctx, 0, 0, W, H, 24);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.save();
    roundRect(ctx, 0, 0, W, H, 24);
    ctx.clip();
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(0, H - 14, W, 14);
    ctx.fillStyle = 'rgba(88,101,242,0.18)';
    ctx.beginPath();
    ctx.arc(W - 60, 40, 180, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // avatar circle
    const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
    const avatar = await loadImage(avatarUrl).catch(() => null);
    const ax = 70;
    const ay = H / 2;
    const ar = 85;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + ar, ay, ar, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (avatar) {
      ctx.drawImage(avatar, ax, ay - ar, ar * 2, ar * 2);
    } else {
      ctx.fillStyle = '#5865f2';
      ctx.fillRect(ax, ay - ar, ar * 2, ar * 2);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 72px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(member.user.username[0]?.toUpperCase() ?? '?', ax + ar, ay + 26);
    }
    ctx.restore();
    // avatar ring
    ctx.strokeStyle = '#57f287';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(ax + ar, ay, ar + 4, 0, Math.PI * 2);
    ctx.stroke();

    // text
    const name = member.user.globalName ?? member.user.username;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#949ba4';
    ctx.font = '600 30px sans-serif';
    ctx.fillText('WELCOME TO', ax + ar * 2 + 45, ay - 55);

    ctx.fillStyle = '#ffffff';
    let size = 52;
    ctx.font = `bold ${size}px sans-serif`;
    while (ctx.measureText(name).width > W - (ax + ar * 2 + 45) - 40 && size > 24) {
      size -= 4;
      ctx.font = `bold ${size}px sans-serif`;
    }
    ctx.fillText(name.slice(0, 28), ax + ar * 2 + 45, ay - 5);

    ctx.fillStyle = '#dbdee1';
    ctx.font = '500 34px sans-serif';
    ctx.fillText(member.guild.name.slice(0, 34), ax + ar * 2 + 45, ay + 45);

    ctx.fillStyle = '#949ba4';
    ctx.font = '400 26px sans-serif';
    ctx.fillText(`Member #${member.guild.memberCount}`, ax + ar * 2 + 45, ay + 85);

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'welcome.png' });
  } catch {
    return null;
  }
}
