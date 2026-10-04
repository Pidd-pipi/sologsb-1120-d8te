/** 仪器预约记录（跨页签占用） */
export interface InstrumentReservation {
  /** `${instrumentId}__${tabToken}` */
  id: string;
  instrumentId: string;
  clockId: string;
  tabToken: string;
  slotStart: number;
  slotEnd: number;
  expireAt: number;
  createdAt: number;
}
