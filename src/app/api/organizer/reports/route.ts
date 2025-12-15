import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorResponse, successResponse } from "@/lib/response";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { Role } from "@prisma/client";

export async function GET(req: NextRequest) {
  console.log('[/api/admin/reports] Starting request processing');
  try {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log('[/api/admin/reports] Database connection successful');
    } catch (dbError) {
      console.error('[/api/admin/reports] Database connection error:', dbError);
      throw new Error('Database connection error');
    }
    const userRole = req.headers.get("x-user-role");
    const authHeader = req.headers.get("authorization");
    
    console.log('[/api/admin/reports] Headers:', {
      userRole,
      authHeader: authHeader ? 'present' : 'missing',
      host: req.headers.get('host'),
      xForwardedHost: req.headers.get('x-forwarded-host')
    });
    
    if (!userRole) {
      console.error('[/api/admin/reports] Missing user role in headers');
      throw new UnauthorizedError("User not authenticated");
    }

    if (userRole !== Role.Admin) {
      throw new ForbiddenError("Admin access required");
    }

    let totalUsers, totalEvents, totalReservations, totalTickets;
    
    try {
      [totalUsers, totalEvents, totalReservations, totalTickets] = await Promise.all([
        prisma.user.count().catch(e => { console.error('Error counting users:', e); return 0; }),
        prisma.event.count().catch(e => { console.error('Error counting events:', e); return 0; }),
        prisma.reservation.count().catch(e => { console.error('Error counting reservations:', e); return 0; }),
        prisma.ticket.count().catch(e => { console.error('Error counting tickets:', e); return 0; }),
      ]);
      console.log('[/api/admin/reports] Counts loaded:', {
        users: totalUsers,
        events: totalEvents,
        reservations: totalReservations,
        tickets: totalTickets
      });
    } catch (countError) {
      console.error('[/api/admin/reports] Error getting counts:', countError);
      throw new Error('Failed to load report data');
    }

    const revenueResult = await prisma.payment.aggregate({
      where: {
        status: "Completed"
      },
      _sum: {
        amount: true
      }
    });
    const totalRevenue = revenueResult._sum.amount || 0;

    const recentUsers = await prisma.user.findMany({
      take: 3,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
      },
    });

    // Assuming organizerId is passed as a query parameter or header; adjust as needed
    const organizerId = req.nextUrl.searchParams.get("organizerId") || req.headers.get("x-organizer-id");
    const recentEvents = await prisma.event.findMany({
      take: 3,
      orderBy: { createdAt: "desc" },
      where: organizerId ? { organizerId: organizerId } : {},
      select: {
        id: true,
        title: true,
        createdAt: true,
        organizer: {
          select: { name: true }
        }
      },
    });

    const recentReservations = await prisma.reservation.findMany({
      take: 3,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { name: true }
        },
        tickets: {
          include: {
            Event: {
              select: { title: true }
            }
          }
        }
      },
    });

    const recentPayments = await prisma.payment.findMany({
      take: 3,
      orderBy: { createdAt: "desc" },
      where: {
        status: "Completed"
      },
      select: {
        id: true,
        amount: true,
        createdAt: true,
        reservation: {
          select: {
            user: {
              select: { name: true }
            }
          }
        }
      },
    });

    const recentActivity = [
      ...recentUsers.map(user => ({
        id: `user-${user.id}`,
        type: "user_registered" as const,
        description: `New user registered: ${user.name} (${user.email})`,
        timestamp: user.createdAt.toISOString(),
      })),
      ...recentEvents.map(event => ({
        id: `event-${event.id}`,
        type: "event_created" as const,
        description: `New event created: ${event.title} by ${event.organizer.name}`,
        timestamp: event.createdAt.toISOString(),
      })),
      ...recentReservations.map(reservation => ({
        id: `reservation-${reservation.id}`,
        type: "reservation_made" as const,
        description: `${reservation.user?.name || 'A user'} made a reservation for ${reservation.tickets?.[0]?.Event?.title || 'an event'}`,
        timestamp: reservation.createdAt.toISOString(),
      })),
      ...recentPayments.map(payment => ({
        id: `payment-${payment.id}`,
        type: "payment_completed" as const,
        description: `Payment completed: $${payment.amount.toFixed(2)} by ${payment.reservation.user.name}`,
        timestamp: payment.createdAt.toISOString(),
      })),
    ]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10);

    const usersByRole = await prisma.user.groupBy({
      by: ['role'],
      _count: {
        role: true
      }
    });

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const eventsByMonth = await prisma.event.groupBy({
      by: ['createdAt'],
      where: {
        createdAt: {
          gte: sixMonthsAgo
        }
      },
      _count: {
        id: true
      }
    });

    const reportData = {
      totalUsers,
      totalEvents,
      totalReservations,
      totalTickets,
      totalRevenue: Number(totalRevenue),
      recentActivity,
      usersByRole: usersByRole.map(item => ({
        role: item.role,
        count: item._count.role
      })),
      eventsByMonth: eventsByMonth.length
    };

    console.log('[/api/admin/reports] Report data generated successfully');
    return successResponse(reportData, "Reports retrieved successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;
    
    console.error('[/api/admin/reports] Error:', {
      message: errorMessage,
      stack,
      name: error instanceof Error ? error.name : 'UnknownError',
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      prismaVersion: require('@prisma/client/package.json').version
    });
    
    if (process.env.NODE_ENV === 'production') {
      return errorResponse(new Error('An error occurred while generating the report'));
    }
    
    return errorResponse(error);
  } finally {
    console.log('[/api/admin/reports] Request completed');
  }
}