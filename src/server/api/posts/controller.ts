import {NextFunction, Request, Response} from "express";
import {respondWith} from "../../utils/index";
import {isValidPostContent, isValidStringId, isValidTimestamp, utcTimestamp} from "../../../shared/utils";
import {Activity, isValidPostVisibility, PostVisibilities} from "../../../shared/interf";
import {MAX_VISIBLE_CIRCLE_NUMBER, POSTS_GROUP_SIZE} from "../../../shared/constants";
import {PostBuilder, PostModel, PostObserver, PublishPostData} from "../../models/post.model";
import db from "../../persistence/index";
import {$id, circleObfuscator, INVALID_NUMERIC_ID, postObfuscator} from "../../service/obfuscator.service";
import {ActivityModel, RawActivity, RawMentionActivities} from "../../models/activity.model";
import {
  BroadcastParams,
  NotificationModel,
  RawBulkNotifications,
  RawNotification
} from "../../models/notification.model";
import {CommentModel} from "../../models/comment.model";
import {getRequestUser} from "../../service/auth.service";
import {isString} from "util";
import {PublishPostRequest} from "../../../shared/contracts";
import _ from 'lodash';
import {messengerService, RawAlikeNotifications} from "../../service/messenger.service";
import {bulkInsertIds} from "../../models/model-base";

const filterShareCircleIds = function(circleIds: any): number[] {
  const result: number[] = [];
  if (circleIds && circleIds.length) {
    const end = Math.max(MAX_VISIBLE_CIRCLE_NUMBER, circleIds.length);
    let id;
    for (let i = 0; i < end; ++i) {
      id = circleIds[i];
      if (isValidStringId(id)) {
        const circleId: number = circleObfuscator.unObfuscate(id);
        if (INVALID_NUMERIC_ID !== circleId) {
          result.push(circleId);
        }
      }
    }
  }
  return result;
};

const getNewPostPayloadOrErr = function(body: PublishPostRequest): PublishPostData | string {
  let {reShareFromPostId, visibility, content, visibleCircleIds} = body;
  let reShareId: number | undefined;
  content = String(content || '').trim();
  if (reShareFromPostId) {
    if (!isValidStringId(reShareFromPostId) || INVALID_NUMERIC_ID === (reShareId = postObfuscator.unObfuscate(reShareFromPostId))) {
      return `invalid reshare post id`;
    }
  }

  if (!content && !reShareFromPostId) {
    return `no post content`;
  } else if (!isValidPostContent(content)) {
    return `invalid content length`;
  }

  if (!visibility && visibleCircleIds && visibleCircleIds.length) {
    visibility = PostVisibilities.Private;
  }

  if (!isValidPostVisibility(visibility)) {
    return `invalid post visibility!`;
  }

  let unObfuscatedCircleIds: number[] | undefined;

  if (visibility === PostVisibilities.Private) {
    unObfuscatedCircleIds = filterShareCircleIds(visibleCircleIds);
  }

  return {
    reShareFromPostId: reShareId,
    visibility,
    content,
    visibleCircleIds: unObfuscatedCircleIds
  };
};


export const publishNewPost = async function(req: Request, res: Response, next: NextFunction) {
  const {body} = req;

  const data = getNewPostPayloadOrErr(body);
  if (isString(data)) {
    return respondWith(res, 400, data);
  }

  const timestamp = utcTimestamp();
  const author = getRequestUser(req);
  const postBuilder = new PostBuilder(author, data, timestamp);
  const [mentions, rawPost] = await postBuilder.build();
  const subscriberIds = await author.getSubscriberIds();
  const mentionIds = mentions.map(m => m.id);
  let rawMentionAlikes: RawAlikeNotifications | undefined;
  await db.inTransaction(async (connection) => {
    const postId = await PostModel.insert(rawPost, connection);

    const rawPostActivity = {
      subjectId: author[$id],
      objectId: postId,
      objectType: Activity.ObjectTypes.Post,
      actionType: Activity.ContentActions.Create,
      timestamp,
    };
    const postActivityId = await ActivityModel.insert(rawPostActivity, connection);
    if (subscriberIds && subscriberIds.length) {

      const params: BroadcastParams = {
        recipientIds: subscriberIds,
        activityId: postActivityId,
        timestamp,
      };
      await NotificationModel.broadcastInsert(params, connection);
    }

    if (!_.isEmpty(mentionIds)) {
      const rawMentionActivities: RawMentionActivities = {
        mentionIds,
        subjectId: author[$id],
        timestamp,
        contextId: postId,
        contextType: Activity.ContextTypes.Post
      };
      const rawMentionNotifications: RawBulkNotifications = {
        recipientIds: mentionIds,
        activityIds: bulkInsertIds(await ActivityModel.insertMentions(rawMentionActivities, connection)),
        timestamp
      };

      rawMentionAlikes = {
        notificationIds: bulkInsertIds(await NotificationModel.insertBulkNotifications(rawMentionNotifications, connection)),
        recipientIds: mentionIds,
        subjectId: rawMentionActivities.subjectId,
        contextId: rawMentionActivities.contextId,
        contextType: rawMentionActivities.contextType,
        timestamp,
        objectType: Activity.ObjectTypes.User,
        actionType: Activity.UserActions.Mention,
      };
    }
  });
  respondWith(res, 200);
  if (rawMentionAlikes) {
    await messengerService.postRawAlikeNotifications(rawMentionAlikes);
  }
};


export const getPublicStreamPosts = async function(req: Request, res: Response, next: NextFunction) {
  const {query} = req;
  const timestamp = Math.floor(parseFloat(query.t));
  const group = Math.floor(parseFloat(query.g));

  if (!isValidTimestamp(timestamp) || group < 0) {
    return respondWith(res, 404);
  }

  const observer = getRequestUser(req);
  const params = {
    timestamp,
    offset: group * POSTS_GROUP_SIZE,
    observerId: observer[$id],
  };

  let posts = await PostModel.getPublicTimelinePosts(params);

  if (!posts.length) {
    return respondWith(res, 200);
  }

  for (const p of posts) {
    p.comments = await CommentModel.getCommentsForPost({
      postId: p[$id],
      observerId: observer[$id]
    });
  }
  respondWith(res, 200, JSON.stringify(posts));
};

export const getPostById = async function(req: Request, res: Response, next: NextFunction) {
  const {id} = req.params;
  const postId = postObfuscator.unObfuscate(id);
  if (INVALID_NUMERIC_ID !== postId) {
    const observer = getRequestUser(req);
    const postViewer = {
      postId,
      observerId: observer[$id]
    };
    const post = await PostModel.getPostById(postViewer);
    if (post) {
      post.comments = await CommentModel.getCommentsForPost(postViewer);
      return res.json(post);
    }
  }
  return respondWith(res, 404);
};

export const plusPost = async function(req: Request, res: Response, next: NextFunction) {
  const {id} = req.params;
  const postId = postObfuscator.unObfuscate(id);
  if (INVALID_NUMERIC_ID !== postId) {
    const observer = getRequestUser(req);
    const postViewer: PostObserver = {
      postId, observerId: observer[$id]
    };
    const authorId = await PostModel.getAuthorIdIfAccessible(postViewer);
    if (INVALID_NUMERIC_ID !== authorId) {
      const isAuthor = authorId === observer[$id];
      let rawActivity: RawActivity;
      let rawNotification: RawNotification;
      let notificationId: number;
      const timestamp = utcTimestamp();
      await db.inTransaction(async (conn) => {
        await conn.query('INSERT INTO PostPlusOnes (postId, userId) VALUES (:postId, :observerId)', postViewer);

        rawActivity = {
          subjectId: observer[$id],
          objectId: postId,
          objectType: Activity.ObjectTypes.Post,
          actionType: Activity.ContentActions.PlusOne,
          timestamp,
        };
        const activityId = await ActivityModel.insert(rawActivity, conn);
        if (!isAuthor) {
          rawNotification = {
            recipientId: authorId,
            activityId,
            timestamp,
          };
          notificationId = await NotificationModel.insert(rawNotification, conn);
        }
        await conn.query('UPDATE Posts SET plusCount = plusCount + 1 WHERE id = :postId', postViewer);
      });
      respondWith(res, 200);
      if (!isAuthor) {
        return messengerService.postRawNotification({
          rawActivity: rawActivity!,
          rawNotification: rawNotification!,
          notificationId: notificationId!,
        });
      }
      return;
    }
  }
  return respondWith(res, 404);
};

export const unPlusPost = async function(req: Request, res: Response, next: NextFunction) {
  const {id} = req.params;
  const postId = postObfuscator.unObfuscate(id);
  if (INVALID_NUMERIC_ID !== postId) {
    const observer = getRequestUser(req);
    const postViewer: PostObserver = {
      postId, observerId: observer[$id]
    };
    if (await PostModel.isAccessible(postViewer)) {
      await db.inTransaction(async (conn) => {
        const [result] = await conn.query('DELETE FROM PostPlusOnes WHERE postId = :postId AND userId = :observerId', postViewer);
        if (!result || 1 !== (result as any).affectedRows) {
          throw Error('No plus one to delete!');
        }
        await conn.query('UPDATE Posts SET plusCount = plusCount - 1 WHERE id = :postId', postViewer);
      });
      return respondWith(res, 200);
    }
  }
  return respondWith(res, 404);
};
