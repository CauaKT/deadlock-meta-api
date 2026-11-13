import { PrismaClient, Role } from '@prisma/client';

const emailArg = process.argv[2]?.trim().toLowerCase();
const demote = process.argv.includes('--demote');

if (!emailArg || emailArg.startsWith('--')) {
  console.error('Uso: npm run admin:promote -- email@exemplo.com [--demote]');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const user = await prisma.user.findUnique({
    where: { email: emailArg },
    select: { id: true, email: true, role: true },
  });

  if (!user) {
    console.error(`Usuário não encontrado para o e-mail: ${emailArg}`);
    process.exit(1);
  }

  const nextRole = demote ? Role.USER : Role.ADMIN;

  if (user.role === Role.ADMIN && nextRole === Role.USER) {
    const adminCount = await prisma.user.count({ where: { role: Role.ADMIN } });
    if (adminCount <= 1) {
      console.error('Operação bloqueada: não é possível rebaixar o último administrador.');
      process.exit(1);
    }
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: nextRole },
    select: { id: true, email: true, role: true },
  });

  console.log(`Role atualizada com sucesso: ${updated.email} -> ${updated.role}`);
} finally {
  await prisma.$disconnect();
}