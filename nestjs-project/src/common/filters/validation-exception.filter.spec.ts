import { BadRequestException, ArgumentsHost } from '@nestjs/common';
import { ValidationExceptionFilter } from './validation-exception.filter';
import { createArgumentsHostMock } from '../../test/arguments-host-mock';

describe('ValidationExceptionFilter', () => {
  let filter: ValidationExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new ValidationExceptionFilter();
    ({
      host: mockHost,
      status: mockStatus,
      json: mockJson,
    } = createArgumentsHostMock());
  });

  it('normalizes array of class-validator messages', () => {
    const exception = new BadRequestException({
      message: [
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ],
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: [
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ],
    });
  });

  it('wraps single string message into array', () => {
    const exception = new BadRequestException({
      message: 'Invalid input',
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: ['Invalid input'],
    });
  });
});
