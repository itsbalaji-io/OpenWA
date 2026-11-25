import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageModule } from '../message/message.module';
import { MyStatusController, StatusController } from './status.controller';
import { StatusService } from './status.service';
import { StatusStoreModule } from '../status-store/status-store.module';
import { Session } from '../session/entities/session.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Session], 'data'), MessageModule, StatusStoreModule],
  controllers: [MyStatusController, StatusController],
  providers: [StatusService],
  exports: [StatusService],
})
export class StatusModule {}
