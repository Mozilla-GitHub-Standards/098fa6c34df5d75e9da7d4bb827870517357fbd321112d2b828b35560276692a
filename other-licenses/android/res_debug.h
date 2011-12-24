/*	$NetBSD: res_debug.h,v 1.1.1.1 2004/05/20 17:18:55 christos Exp $	*/

/*
 * Copyright (c) 2004 by Internet Systems Consortium, Inc. ("ISC")
 * Copyright (c) 1999 by Internet Software Consortium.
 *
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS.  IN NO EVENT SHALL ISC BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
 * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

/*
 * This version of this file is derived from Android 2.3 "Gingerbread",
 * which contains uncredited changes by Android/Google developers.  It has
 * been modified in 2011 for use in the Android build of Mozilla Firefox by
 * Mozilla contributors (including Michael Edwards <m.k.edwards@gmail.com>,
 * and Steve Workman <sjhworkman@gmail.com>).
 * These changes are offered under the same license as the original NetBSD
 * file, whose copyright and license are unchanged above.
 */

#ifndef _RES_DEBUG_H_
#define _RES_DEBUG_H_

#ifndef DEBUG
#   define Dprint(cond, args) /*empty*/
#   define DprintQ(cond, args, query, size) /*empty*/
#   define Aerror(statp, file, string, error, address) /*empty*/
#   define Perror(statp, file, string, error) /*empty*/
#else
#   define Dprint(cond, args) if (cond) {fprintf args;} else {}
#   define DprintQ(cond, args, query, size) if (cond) {\
			fprintf args;\
			res_pquery(statp, query, size, stdout);\
		} else {}
#endif

#endif /* _RES_DEBUG_H_ */ 