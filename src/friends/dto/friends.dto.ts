import { IsBoolean, IsUUID } from 'class-validator';

export class SendFriendRequestDto {
  @IsUUID('4', { message: 'Usuário de destino inválido.' })
  targetUserId: string;
}

export class UpdateFriendsPrivacyDto {
  @IsBoolean({ message: 'Valor de privacidade inválido.' })
  friendsPublic: boolean;
}